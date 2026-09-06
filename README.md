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

Every draft passes the grounding gate: a second model checks claims against retrieved excerpts.
The score decides send / review / block. The gate fails closed — judge errors go to review.

## Quick start

```bash
npm install
cp .env.example .env      # Supabase + one LLM key + admin credentials
npm run db:init           # migrate, create bucket, seed settings
npm run db:seed           # optional demo vault
npm run dev
```

Open http://localhost:3000 — the landing page shows what is still unconfigured.

### Configuration

Non-secret defaults live in `src/lib/app-config.ts`. `.env` holds credentials and connection
strings. Dashboard settings (`app_settings`) override both — `npm run db:status` shows the
effective config and flags shadowed values.

### Minimum configuration

| Variable | Where to get it |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SECRET_KEY` | Supabase → Project Settings → API keys |
| `SUPABASE_DB_URL` | Supabase → Project Settings → Database → Connection string |
| `MISTRAL_API_KEY` | console.mistral.ai — covers chat *and* embeddings |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | your choice; dashboard login |

Defaults run on Mistral free tier (`ministral-14b-latest` + `mistral-embed`). Other providers
(OpenAI, Anthropic, Google, Groq, DeepSeek, xAI, Cohere, Azure, OpenRouter, Ollama) can be set
in `.env` or the dashboard.

To switch embedding models, change `EMBEDDING_*` then run `npm run db:reembed` (backfill, old
vectors are kept).

### Demo mode

`DEMO_MODE=true` removes the sign-in and gives every visitor full admin access — vault uploads,
settings, provider keys, and approving a draft, **which sends a real email**. Nothing is stubbed;
the point is that a reviewer can exercise the whole system.

Unlike `DEV_AUTH_BYPASS` it applies in production and on Vercel, so it is off by default,
announced in the UI on every page, and logs a warning on first use. Turn it off afterwards.

## Uploading a vault

**Dashboard → Vault** accepts a zip or folder pick. Zips are archived to Supabase Storage for
re-indexing later. For large vaults:

```bash
npm run vault:ingest -- "C:/Users/you/Documents/MyVault"
```

Re-ingests skip unchanged notes by content hash. Notes with `private: true`, `publish: false`,
`draft: true`, or `#private` / `#secret` / `#noindex` are never chunked or embedded.

## Email

Resend on a verified domain. Replies thread correctly and include source notes plus HTML and
plain-text parts.

```bash
npm run mail:test -- you@example.com           # render only
npm run mail:test -- you@example.com --live    # actually send
npm run mail:inbound -- "What is the default retry count?"  # full pipeline locally
```

Receiving: point MX for the inbound domain at Resend, add an `email.received` webhook to
`/api/inbound/resend`, and set `RESEND_WEBHOOK_SECRET`. Deliveries are deduplicated by event id.

## Evaluation

Prompts in `src/prompts/`, judges in `src/evaluator/prompts/`.

```bash
cp src/evaluator/datasets/golden.example.jsonl src/evaluator/datasets/golden.jsonl
npm run eval                                   # full run
npm run eval -- --fast                         # deterministic metrics only
npm run eval -- --prompt senderAgentTerse      # score a prompt variant
npm run eval -- --compare eval-results/x.json  # diff against a previous run
```

Scored axes: groundedness (weighted highest), citation validity, answer relevance,
correctness, context recall/precision, refusal correctness, tone. Exits non-zero below
`EVAL_PASS_THRESHOLD`. Aim for 30–60 cases: ~60% answerable, 20% `shouldRefuse`, 20% awkward
phrasing.

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run db:init` | Migrate, create bucket, seed settings. Idempotent. |
| `npm run db:migrate` / `db:seed` / `db:status` | Apply migrations / load demo vault / show effective config |
| `npm run db:reembed` | Rebuild vectors after an embedding model change |
| `npm run db:reset [--schema]` | Delete content (or everything with `--schema`) |
| `npm run vault:ingest -- <path>` | Index a local vault directory |
| `npm run mail:test -- <to> [--live]` | Render (or send) a test email |
| `npm run mail:inbound -- "<question>"` | Replay a signed inbound webhook locally |
| `npm run eval [-- --fast]` | Run the evaluation harness |

## Layout

```
src/
  app/
    api/          inbound webhook, upload, query, review, auth
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
