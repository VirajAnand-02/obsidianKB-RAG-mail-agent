/**
 * Postgres connection string handling.
 *
 * Supabase generates database passwords from a character set that includes
 * `@ # ? / : % &`, all of which are structural characters in a URI. Pasting such
 * a password into `SUPABASE_DB_URL` verbatim produces a string that either fails
 * to parse or — worse — parses into the wrong host, giving errors like
 * "getaddrinfo ENOTFOUND" that point nowhere near the real cause.
 *
 * Rather than making that the user's problem, the password is percent-encoded
 * here, idempotently, so both an encoded and an unencoded password work.
 */

const PLACEHOLDERS = ["[PASSWORD]", "[PROJECT-REF]", "[YOUR-PASSWORD]", "YOUR-PASSWORD"];

/**
 * Splits a connection URI around the *last* `@`, which is the real userinfo
 * boundary even when the password itself contains one.
 */
const CONNECTION_RE =
  /^(postgres(?:ql)?:\/\/)([^:/?#@]+)(?::([\s\S]*))?@([^@/?#]+)(\/[^?#]*)?(\?[\s\S]*)?$/;

/**
 * Percent-encodes a password without double-encoding one that is already
 * encoded. A value that survives a decode/encode round trip unchanged was
 * already encoded and is left alone.
 */
function encodePassword(password: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(password);
  } catch {
    // Contains a bare `%` that is not a valid escape, so it is literal.
    decoded = password;
  }
  return encodeURIComponent(decoded);
}

export interface NormalisedDbUrl {
  url: string;
  host: string;
  /** True when the password contained characters that needed escaping. */
  wasEncoded: boolean;
}

export class DbUrlError extends Error {}

/**
 * Validates and normalises `SUPABASE_DB_URL`.
 * Throws a `DbUrlError` with actionable guidance rather than letting a
 * malformed URI surface as a DNS failure later.
 */
export function normaliseDbUrl(raw: string | undefined): NormalisedDbUrl {
  const value = (raw ?? "").trim();

  if (!value) {
    throw new DbUrlError(
      "SUPABASE_DB_URL is not set.\n" +
        "  Supabase Dashboard -> Project Settings -> Database -> Connection string (URI).\n" +
        "  Choose the URI tab and copy the whole line, then replace [YOUR-PASSWORD]\n" +
        "  with your database password.",
    );
  }

  const placeholder = PLACEHOLDERS.find((p) => value.includes(p));
  if (placeholder) {
    throw new DbUrlError(
      `SUPABASE_DB_URL still contains the placeholder "${placeholder}".\n` +
        "  Replace it with the real value from the Supabase dashboard.\n" +
        "  If you have lost the database password, reset it under\n" +
        "  Project Settings -> Database -> Database password.",
    );
  }

  const match = value.match(CONNECTION_RE);
  if (!match) {
    throw new DbUrlError(
      "SUPABASE_DB_URL is not a valid Postgres connection URI.\n" +
        "  Expected: postgresql://USER:PASSWORD@HOST:5432/postgres\n" +
        `  Received: ${redact(value)}\n` +
        "  Make sure the whole value is on one line and is not wrapped in quotes.",
    );
  }

  const [, scheme, user, password = "", hostPort, database, query] = match;

  const encoded = encodePassword(password);
  const wasEncoded = encoded !== password;

  const url = `${scheme}${user}:${encoded}@${hostPort}${database ?? "/postgres"}${query ?? ""}`;

  return { url, host: hostPort, wasEncoded };
}

/** Masks the password so a connection string can be safely logged. */
export function redact(connectionString: string): string {
  return connectionString.replace(
    /^(postgres(?:ql)?:\/\/)([^:/?#@]+)(?::[\s\S]*)?@/,
    "$1$2:****@",
  );
}

/**
 * Supabase requires TLS but serves a certificate chain Node does not trust by
 * default. The connection is still encrypted and is made to Supabase's own
 * hostname.
 */
export const SSL_CONFIG = { rejectUnauthorized: false } as const;
