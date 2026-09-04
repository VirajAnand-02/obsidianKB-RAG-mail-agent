import "dotenv/config";
import { readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { normaliseDbUrl, redact, SSL_CONFIG } from "@/lib/db-url";

/**
 * Migration runner.
 *
 * Applies every .sql file in supabase/migrations in filename order, once, inside
 * a transaction. Applied files are recorded with a checksum in `_migrations`, so
 * a migration edited after it was applied is reported rather than silently
 * skipped — that mismatch is almost always a mistake worth surfacing.
 */

const MIGRATIONS_DIR = path.join(process.cwd(), "supabase", "migrations");

export interface MigrateOptions {
  /** Report what would run without applying anything. */
  dryRun?: boolean;
  /** Re-apply a migration whose checksum no longer matches. */
  force?: boolean;
}

export async function migrate(options: MigrateOptions = {}): Promise<{ applied: string[]; skipped: string[] }> {
  // Percent-encodes a password containing URI-structural characters, which
  // Supabase-generated passwords routinely do. Passing the raw value through
  // makes `pg` fail with an opaque "Invalid URL".
  const { url: connectionString, host, wasEncoded } = normaliseDbUrl(process.env.SUPABASE_DB_URL);

  if (wasEncoded) {
    console.log("  note: escaped special characters in the database password\n");
  }

  const client = new pg.Client({ connectionString, ssl: SSL_CONFIG });

  try {
    await client.connect();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw new Error(
      `Could not connect to ${host}: ${message}\n` +
        `  Connection string: ${redact(connectionString)}\n` +
        "  Check the database password, and that the host matches your project.",
    );
  }

  try {
    await client.query(`
      create table if not exists _migrations (
        name        text primary key,
        checksum    text not null,
        applied_at  timestamptz not null default now()
      );
    `);

    const { rows: applied } = await client.query<{ name: string; checksum: string }>(
      "select name, checksum from _migrations",
    );
    const appliedMap = new Map(applied.map((r) => [r.name, r.checksum]));

    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();

    if (files.length === 0) {
      throw new Error(`No .sql files found in ${MIGRATIONS_DIR}`);
    }

    const appliedNow: string[] = [];
    const skipped: string[] = [];

    for (const file of files) {
      const sql = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex").slice(0, 16);
      const previous = appliedMap.get(file);

      if (previous) {
        if (previous !== checksum && !options.force) {
          console.warn(
            `  ! ${file} was already applied but its contents have changed.\n` +
              `    Add a new migration instead of editing this one, or re-run with --force.`,
          );
        }
        if (!options.force) {
          skipped.push(file);
          continue;
        }
      }

      if (options.dryRun) {
        console.log(`  would apply  ${file}`);
        appliedNow.push(file);
        continue;
      }

      process.stdout.write(`  applying     ${file} ... `);

      // Each migration is atomic: a failure leaves the schema untouched, so the
      // file can be fixed and re-run without a partially-applied mess.
      try {
        await client.query("begin");
        await client.query(sql);
        await client.query(
          `insert into _migrations (name, checksum) values ($1, $2)
           on conflict (name) do update set checksum = excluded.checksum, applied_at = now()`,
          [file, checksum],
        );
        await client.query("commit");
        console.log("done");
        appliedNow.push(file);
      } catch (e) {
        await client.query("rollback").catch(() => {});
        console.log("FAILED");
        throw new Error(
          `Migration ${file} failed and was rolled back:\n  ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
    }

    return { applied: appliedNow, skipped };
  } finally {
    await client.end();
  }
}

// Only runs the CLI when this file is the entry point, so `init.ts` can import
// `migrate()` without triggering a second run.
const isEntryPoint =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntryPoint) {
  const dryRun = process.argv.includes("--dry-run");
  const force = process.argv.includes("--force");

  console.log(`\nApplying migrations${dryRun ? " (dry run)" : ""}...\n`);

  migrate({ dryRun, force })
    .then(({ applied, skipped }) => {
      console.log(
        `\n  ${applied.length} applied, ${skipped.length} already up to date.\n`,
      );
      process.exit(0);
    })
    .catch((e) => {
      console.error(`\n${e instanceof Error ? e.message : e}\n`);
      process.exit(1);
    });
}
