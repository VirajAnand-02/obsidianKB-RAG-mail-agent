# Obsi-Relay

Indexes an Obsidian vault into a retrieval-augmented knowledge base and answers questions that
arrive by email — with a grounding check between every draft and the outbox.

Next.js 16 · TypeScript · Supabase (pgvector) · Vercel AI SDK v7 · Resend

---

## What it does

```
 inbound email --> triage --> retrieve --> draft --> grounding gate --+--> send
   (Resend)       (spam,      (hybrid     (sender    (send /          |
                   loops,      search)     agent)     review /        +--> review queue
                   injection)                         block)          |
                                                                      +--> blocked + honest reply
```

Every generated email passes the grounding gate. A second model checks each factual claim
against the retrieved excerpts and scores the draft; the score decides whether it sends
unattended, waits for a human, or never goes out. The gate fails closed — if the judge errors,
the draft goes to review rather than to the recipient.

## Quick start

```bash
npm install
cp .env.example .env      # Supabase + one LLM key + admin credentials
npm run db:init           # migrate, create bucket, seed settings
npm run db:seed           # optional: a small demo vault to try it out
npm run dev
```

Open http://localhost:3000 — the landing page lists exactly what is still unconfigured.

`MAIL_DRY_RUN=true` is the default. Emails are rendered and logged but never delivered until
you turn it off deliberately.

### Configuration

Non-secret application defaults, provider endpoints, retrieval tuning, ingestion limits, email
defaults, grounding thresholds and evaluator settings live in `src/lib/app-config.ts`. Keep
`.env` for credentials, signing/encryption keys and the Supabase database connection string.
Dashboard settings in `app_settings` override the runtime tuning values from `app-config.ts`.

### Minimum configuration

| Variable | Where to get it |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SECRET_KEY` | Supabase → Project Settings → API keys |
| `SUPABASE_DB_URL` | Supabase → Project Settings → Database → Connection string (URI) |
| `MISTRAL_API_KEY` | console.mistral.ai — free tier covers chat *and* embeddings |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | whatever you choose; this is the dashboard login |

Paste the database password exactly as generated. Supabase passwords routinely contain
`@ # ? / : &`, which are structural characters in a URI — they are percent-encoded
automatically, so no manual escaping is needed.

## Signing in

The dashboard has one account, configured entirely in the environment:

```bash
ADMIN_EMAIL=you@yourdomain.com
ADMIN_PASSWORD=a-long-random-passphrase
AUTH_SECRET=                # signs the session cookie; falls back to SETTINGS_ENCRYPTION_KEY
AUTH_SESSION_DAYS=7
```

There is no signup, no password reset and no user table — this is a single-operator tool for
one person's notes, so an identity provider would be more moving parts than the problem needs.

The session is an HMAC-signed cookie (`httpOnly`, `sameSite=lax`, `secure` in production)
rather than a random token in a table: with one account there is no session list worth keeping.
Changing `AUTH_SECRET` or `ADMIN_EMAIL` invalidates every outstanding session, which is the
sign-out-everywhere lever.

Failed logins are throttled per IP (8 attempts per 10 minutes), and a wrong email and a wrong
password return the same message, so the endpoint cannot confirm which is which.

### Local development skips the login

Signing in on every restart buys nothing locally, so the admin is returned automatically in
development. The guards are deliberately belt-and-braces:

- `VERCEL` is set on every Vercel build and runtime, so a deployment can never bypass. This
  matters because `.env` contains `NODE_ENV=development`, and copying that file into Vercel's
  environment variables is an easy mistake to make.
- `NODE_ENV` must not be `production`. `next build` and `next start` force it there regardless
  of `.env`.
- `DEV_AUTH_BYPASS=false` opts out, to exercise the real login locally.

When the bypass is active the sidebar says so in red and the server logs a warning once.

## Free-tier setup

The defaults run without a paid account: Mistral for both generation (`ministral-14b-latest`)
and embeddings (`mistral-embed`, 1024d).

Mistral's free tier does **not** include `mistral-small/medium/large`. The models that work are
`ministral-3b-latest`, `ministral-8b-latest`, `ministral-14b-latest` and `open-mistral-nemo`.

Other free embedding options, selectable in **Settings → Embeddings**:

| Provider | Model | Dims | Notes |
| --- | --- | --- | --- |
| Mistral | `mistral-embed` | 1024 | Default. Free tier. |
| Google | `text-embedding-004` | 768 | Generous free tier via AI Studio. |
| Ollama | `nomic-embed-text` | 768 | Fully local, no API key, no rate limit. |
| Ollama | `all-minilm` | 384 | Local, tiny, fast. |
| Jina | `jina-embeddings-v3` | 1024 | Free tokens on signup. |
| Cohere | `embed-english-v3.0` | 1024 | Free trial keys. |

Generation providers work the same way — OpenAI, Anthropic, Google, Mistral, Groq, DeepSeek,
xAI, Cohere, Azure, OpenRouter, Ollama, or any OpenAI-compatible endpoint. Set the default in
`.env`, change it in the dashboard, and every call site follows: answering, triage, query
expansion, grounding, and the evaluator's judge.

> **Settings in the database override `.env`.** After changing `LLM_MODEL` in `.env`, either
> re-run `npm run db:init` to re-seed it or change it in the dashboard. `npm run db:status`
> prints the effective configuration and flags anything being shadowed.

### Switching embedding model safely

Different models produce different dimensions, so vectors live in **per-dimension tables**
(`embeddings_384` … `embeddings_3072`) with an `embedding_spaces` registry recording which
`(provider, model, dimensions)` is live.

Switching model is therefore a backfill, never a migration:

```bash
# change EMBEDDING_* in .env or Settings, then
npm run db:reembed
```

The old vectors stay in their own space until you drop them, so switching back costs nothing.
`vector` is used up to 2000 dimensions and `halfvec` beyond it, because pgvector's HNSW index
caps out at 2000 for the full-precision type.

## Uploading a vault

**Dashboard → Vault** takes either a zipped vault or a direct folder pick (`webkitdirectory`,
Chromium only). Zip uploads are archived to Supabase Storage so the vault can be re-indexed
later without re-uploading.

For large vaults during development, skip the browser entirely:

```bash
npm run vault:ingest -- "C:/Users/you/Documents/MyVault"
```

Re-ingesting is cheap: notes are skipped by content hash, so a 2,000-note vault where five
notes changed costs five notes' worth of embedding calls.

**Privacy.** Notes with `private: true`, `publish: false`, `draft: true`, or a tag from
`INGEST_PRIVATE_TAGS` (`#private`, `#secret`, `#noindex`) are recorded but never chunked or
embedded, so they cannot be retrieved or quoted.

## Retrieval

```
question
  -> query expansion (keyword / restated / hypothetical-answer variants)
  -> embed each variant
  -> hybrid search per variant  (pgvector + Postgres full-text, fused with RRF in SQL)
  -> fuse across variants
  -> neighbour-window expansion
  -> optional cross-encoder rerank (Cohere or Jina)
  -> pack into a token-budgeted context block with [C1]..[Cn] citation ids
```

Reciprocal Rank Fusion is used rather than a weighted score blend because cosine similarity and
`ts_rank` live on incompatible scales — normalising them against each other needs per-corpus
tuning, while RRF only needs rank order.

Chunking splits on heading structure first, then packs to 512 tokens with 64 of overlap, never
splits a fenced code block or table, and prepends a `Note > H1 > H2` breadcrumb to every chunk.
That breadcrumb is the cheapest retrieval win available: a chunk reading "set it to 3" is
unretrievable, while the same chunk under "Retry policy > Defaults" is not.

Every stage is switchable from **Settings**, which matters because the evaluator scores
configurations against each other.

## Email

### Sending

Resend, on a domain you have verified. Replies carry `In-Reply-To`/`References` so clients
thread them, list the source notes in the footer, and ship both HTML and a real plain-text
alternative.

```bash
npm run mail:test -- you@example.com           # render only, sends nothing
npm run mail:test -- you@example.com --live    # actually send
```

`--live` overrides `MAIL_DRY_RUN` for one message, so you can verify DNS without disarming the
global safety switch.

### Receiving

1. Point the MX records for `RESEND_INBOUND_DOMAIN` (e.g. `ask.yourdomain.com`) at Resend.
2. Add a webhook for `email.received` → `https://yourdomain.com/api/inbound/resend`.
3. Put the signing secret in `RESEND_WEBHOOK_SECRET`.

Signature verification is mandatory in production — without it, anyone who learns the endpoint
URL can make the system email arbitrary people from your verified domain. Webhook deliveries
are deduplicated by provider event id, so a retry cannot answer the same message twice.

To exercise the whole pipeline without waiting on DNS:

```bash
npm run mail:inbound -- "What is the default retry count?"
```

That posts a correctly Svix-signed synthetic `email.received` event at a running dev server, so
signature verification, triage, retrieval, drafting and the gate all run for real.

## Traces

**Dashboard → Traces** lists every inbound message and what happened to it, filterable by
outcome (sent / awaiting review / blocked / ignored / failed) and searchable by sender or
subject.

Opening one shows the whole journey in the order the pipeline ran it:

1. **Received** — sender, Message-ID, raw body
2. **Triage** — accepted, or the exact reason it was filtered out
3. **Retrieval** — every chunk with its note path, similarity and RRF score, neighbours marked
4. **Draft** — the model, latency, token counts, and the generated text
5. **Grounding gate** — verdict, score, and the per-claim supported/partial/unsupported breakdown
6. **Human review** — who approved or rejected it, when, and any edit
7. **Delivery** — the Resend message id, or the error

Nothing extra is recorded to build this; it reconstructs the trace from rows the pipeline
already writes. Messages that were *ignored* are listed alongside answered ones on purpose —
a silently dropped message is the case that is otherwise invisible, and a filter bug once hid
four real emails that way.

The raw webhook payload is one click away at the bottom of each trace, which is the fastest
route to diagnosing a provider-side change.

## Evaluation

Prompts live as markdown in `src/prompts/`, judges in `src/evaluator/prompts/` — editable and
diffable without touching TypeScript.

```bash
cp src/evaluator/datasets/golden.example.jsonl src/evaluator/datasets/golden.jsonl
# replace the cases with questions your vault should answer

npm run eval                                   # full run
npm run eval -- --fast                         # deterministic metrics only, no judge calls
npm run eval -- --prompt senderAgentTerse      # score a prompt variant
npm run eval -- --compare eval-results/x.json  # diff against a previous run
npm run eval -- --tags refusal --repeats 3     # subset, with variance
```

Metrics are scored on separate axes, because a single "rate this 1-10" produces a number nobody
can act on:

| Metric | Judge? | What it catches |
| --- | --- | --- |
| Groundedness | yes | The model answering from its own knowledge instead of the notes |
| Citation validity | no | Citations pointing at excerpts that were never retrieved |
| Answer relevance | yes | Fluent answers to a different question |
| Correctness | yes | Disagreement with a reference answer |
| Context recall / precision | no | Whether a bad answer was a *retrieval* failure |
| Refusal correctness | no | Confident invention on unanswerable questions |
| Tone | yes | Drafts that are accurate but not fit to send |

Groundedness is weighted highest. For a system that emails strangers on your behalf, an
ungrounded answer is worse than a slightly unhelpful one.

`npm run eval` exits non-zero below `EVAL_PASS_THRESHOLD`, so it gates CI like a test suite.
Runs are recorded against the exact prompt hash and configuration that produced them — a score
is only meaningful next to what it was measuring.

A good golden set is 30–60 cases and deliberately includes cases you expect to fail. Roughly
60% answerable, 20% `shouldRefuse`, 20% awkward phrasing and vocabulary mismatches. A set of
only easy questions scores 0.95 and tells you nothing.

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run db:init` | Migrate, create the storage bucket, seed settings. Idempotent. |
| `npm run db:migrate` | Apply migrations (`--dry-run`, `--force`) |
| `npm run db:seed` | Load the demo vault |
| `npm run db:status` | What is configured, migrated, indexed, and in force |
| `npm run db:reembed` | Rebuild vectors after an embedding model change |
| `npm run db:reset` | Delete content, keep schema (`--schema` drops everything) |
| `npm run vault:ingest -- <path>` | Index a local vault directory |
| `npm run mail:test -- <to> [--live]` | Send a test email through Resend |
| `npm run mail:inbound -- "<question>"` | Replay a signed inbound webhook locally |
| `npm run eval` | Run the evaluation harness |

Migrations run one at a time inside a transaction and are checksummed, so a file edited after
it was applied is reported rather than silently skipped.

## Layout

```
src/
  app/
    api/          route handlers (inbound webhook, upload, query, review, auth)
    dashboard/    overview, vault, review queue, playground, evals, settings
  lib/
    ai/           provider registry + multi-provider embeddings
    rag/          markdown parsing, chunking, retrieval, indexing
    agents/       answer, grounding gate, triage, pipeline
    email/        Resend send, inbound parsing, signature verification, HTML rendering
  prompts/        agent prompts (senderAgent, groundingCheck, ...)
  evaluator/      runner, judges, metrics, datasets, CLI
supabase/migrations/
scripts/db/
```

## Security notes

- The Supabase secret key bypasses RLS and is server-only. RLS policies exist as defence in
  depth if the project is ever queried directly.
- Dashboard access is a single environment-configured account. The session cookie is `httpOnly`
  and signed; nothing sensitive is stored in it.
- Provider keys entered in the dashboard are encrypted at rest with AES-256-GCM
  (`SETTINGS_ENCRYPTION_KEY`), so a leaked database dump does not hand over the LLM and Resend
  accounts.
- Prompts treat email bodies and note contents as untrusted data. Triage classifies injection
  attempts as `human`, which routes them to review instead of acting on them.

## Deploying

Push to Vercel, set the same environment variables, and point the Resend webhook at the
deployed URL. `vercel.json` carries the per-route timeouts.

Two things to remember on first deploy: set `MAIL_DRY_RUN=false` when you actually want mail to
go out, and set a real `ADMIN_PASSWORD` — the dev bypass does not apply on Vercel, so the login
is the only way in.
