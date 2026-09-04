import "dotenv/config";
import { ingestFiles } from "@/lib/vault/ingest";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getWorkspaceId, setDefaultVault } from "@/lib/workspace";
import { errorMessage } from "@/lib/logger";

/**
 * Seeds a small demo vault.
 *
 * The notes deliberately mirror the cases in
 * `src/evaluator/datasets/golden.example.jsonl`, so `npm run eval` produces a
 * meaningful score immediately after seeding rather than scoring zero against an
 * empty index. They also include the awkward shapes worth exercising: a note
 * that contradicts an older one, a private note that must never be retrieved,
 * and a note whose vocabulary does not match how anyone would ask about it.
 */

const SAMPLE_NOTES: { path: string; content: string }[] = [
  {
    path: "Engineering/Retry policy.md",
    content: `---
title: Retry policy
tags: [engineering, reliability]
updated: 2026-02-14
---

# Retry policy

## Defaults

The ingest worker retries a failed job **three times** before moving it to the
dead-letter queue. Backoff is exponential, starting at 1.5 seconds and doubling
each attempt, with jitter of up to 500ms.

## Why three

We measured this in January. Attempt two recovers roughly 80% of transient
failures and attempt three recovers a further 15%. Beyond that the recovery rate
falls below 2% per attempt while the queue depth keeps growing, so a fourth
attempt costs latency for everyone without meaningfully improving delivery.

## What is not retried

Validation errors and 4xx responses are terminal. Retrying a malformed payload
produces the same failure and delays the rest of the queue.
`,
  },
  {
    path: "Engineering/Deployment.md",
    content: `---
title: Deployment
tags: [engineering, process]
updated: 2026-03-02
---

# Deployment

Deploys go out through the \`main\` branch. Merging to main triggers the build,
runs the test suite and the evaluation gate, and promotes to staging
automatically.

## Production

Promotion from staging to production is manual and requires an approval from
someone who did not write the change. See [[Approvals]] for who can approve
what.

Roll back with \`vercel rollback\`; it is always safe to roll back first and
diagnose afterwards.
`,
  },
  {
    path: "Team/Approvals.md",
    content: `---
title: Approvals
tags: [team, process]
updated: 2026-01-20
---

# Approvals

Production releases need one approval from a maintainer. Schema migrations need
two, one of which must be from whoever owns the affected service.

Approvals are recorded in the deploy log, not in chat, so that the record
survives the conversation.
`,
  },
  {
    path: "Notes/RAG chunking.md",
    content: `---
title: RAG chunking
tags: [ai, retrieval]
updated: 2026-04-11
---

# RAG chunking

## Size

512 tokens with 64 tokens of overlap is the range that works best for
note-shaped prose. Large enough that a chunk answers a question on its own,
small enough that the embedding is not averaging several unrelated ideas.

## Structure beats windows

Splitting on heading structure first, then packing to size, consistently beats a
fixed sliding window. The author's headings are a free topic segmentation that
someone already thought about.

## Breadcrumbs

Prepending "Note title > H1 > H2" to each chunk costs about ten tokens and makes
otherwise unretrievable chunks findable. A chunk that reads "set it to 3" is
meaningless alone; the same chunk under "Retry policy > Defaults" is not.
`,
  },
  {
    path: "Engineering/Database access.md",
    content: `---
title: Database access
tags: [engineering, database]
updated: 2026-02-28
---

# Database access

Analytics queries go to the read replica, never to the primary.

\`\`\`ts
import { Client } from "pg";

const replica = new Client({
  connectionString: process.env.DATABASE_REPLICA_URL,
  ssl: { rejectUnauthorized: false },
});

await replica.connect();
\`\`\`

Replica lag is typically under two seconds but is not guaranteed. Anything that
must read its own write has to use the primary.
`,
  },
  {
    path: "Notes/Caching strategy (old).md",
    content: `---
title: Caching strategy (old)
tags: [engineering, caching]
updated: 2025-08-03
---

# Caching strategy

We cache rendered pages in Redis with a 15 minute TTL and invalidate on publish.

This has been reliable but the invalidation fan-out gets expensive as the number
of dependent pages grows.
`,
  },
  {
    path: "Notes/Caching strategy.md",
    content: `---
title: Caching strategy
tags: [engineering, caching]
updated: 2026-04-30
---

# Caching strategy

We moved off Redis page caching in April. Pages are now cached at the CDN edge
with stale-while-revalidate, and Redis is used only for session data.

This replaces the approach in [[Caching strategy (old)]]. The invalidation
fan-out problem goes away because the edge revalidates lazily rather than us
pushing invalidations.
`,
  },
  {
    path: "Personal/Salary notes.md",
    content: `---
title: Salary notes
private: true
tags: [personal, private]
---

# Salary notes

This note is marked private and must never be retrieved or quoted in an email.
If it ever appears in an answer, the privacy filter has regressed.
`,
  },
];

async function main() {
  console.log("\nSeeding the demo vault\n");

  const db = supabaseAdmin();
  const workspaceId = await getWorkspaceId();

  const { data: vault, error } = await db
    .from("vaults")
    .insert({
      workspace_id: workspaceId,
      name: "Demo Vault",
      description: "Sample notes for trying out retrieval and the evaluator.",
      source: "seed",
      status: "pending",
    })
    .select("id")
    .single();

  if (error) throw new Error(`Could not create the demo vault: ${error.message}`);
  const vaultId = vault.id as string;

  const result = await ingestFiles(
    SAMPLE_NOTES.map((n) => ({ path: n.path, content: n.content })),
    { vaultId, trigger: "manual" },
  );

  await setDefaultVault(vaultId);

  console.log(`  ${result.stats.notesIndexed} notes indexed`);
  console.log(`  ${result.stats.chunksCreated} chunks created`);
  console.log(`  ${result.stats.notesPrivate} private notes excluded`);
  console.log(`  ${Math.round(result.durationMs / 100) / 10}s\n`);

  if (result.stats.errors.length > 0) {
    console.log("  Errors:");
    for (const e of result.stats.errors) console.log(`    ${e.path}: ${e.error}`);
    console.log();
  }

  console.log("Try it:");
  console.log("  http://localhost:3000/dashboard/playground");
  console.log('  Ask: "What is the default retry count for the ingest worker?"');
  console.log("  Then: npm run eval -- --dataset src/evaluator/datasets/golden.example.jsonl\n");
}

main().catch((e) => {
  console.error(`\nSeed failed: ${errorMessage(e)}\n`);
  process.exit(1);
});
