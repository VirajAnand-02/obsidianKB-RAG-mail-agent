-- 0006_evals.sql
-- Storage for prompt-evaluation runs (src/evaluator).
--
-- Runs are recorded per prompt variant so two versions of senderAgent.md can be
-- scored against the same golden set and compared directly.

set search_path = public, extensions;

create table if not exists eval_runs (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid references workspaces(id) on delete cascade,
  vault_id      uuid references vaults(id) on delete set null,
  name          text not null,
  dataset       text not null,
  -- Which prompt file/version produced the answers under test.
  prompt_name   text not null default 'senderAgent',
  prompt_version text,
  prompt_hash   text,
  -- Full resolved config: providers, models, chunking + retrieval params.
  config        jsonb not null default '{}'::jsonb,
  -- Aggregate metrics: {"overall":0.82,"groundedness":0.91,"recall@8":0.75,...}
  summary       jsonb not null default '{}'::jsonb,
  status        text not null default 'running'
                check (status in ('running', 'completed', 'failed')),
  total_cases   integer not null default 0,
  passed_cases  integer not null default 0,
  git_sha       text,
  error         text,
  started_at    timestamptz not null default now(),
  finished_at   timestamptz
);

create index if not exists eval_runs_created_idx on eval_runs (started_at desc);
create index if not exists eval_runs_prompt_idx  on eval_runs (prompt_name, started_at desc);

create table if not exists eval_results (
  id            uuid primary key default gen_random_uuid(),
  run_id        uuid not null references eval_runs(id) on delete cascade,
  case_id       text not null,
  -- Repeat index when EVAL_REPEATS > 1, for variance measurement.
  repeat_index  integer not null default 0,
  question      text not null,
  expected      text,
  answer        text,
  -- Chunks retrieved, with ids and scores.
  retrieval     jsonb not null default '[]'::jsonb,
  -- Per-metric scores: {"groundedness":1,"relevance":0.8,"tone":0.9,...}
  scores        jsonb not null default '{}'::jsonb,
  -- Raw judge output, kept so a suspicious score can be audited.
  judge         jsonb not null default '{}'::jsonb,
  overall       double precision,
  passed        boolean not null default false,
  latency_ms    integer,
  input_tokens  integer,
  output_tokens integer,
  error         text,
  created_at    timestamptz not null default now(),
  unique (run_id, case_id, repeat_index)
);

create index if not exists eval_results_run_idx on eval_results (run_id, overall);

-- Aggregates for the dashboard's run comparison view.
create or replace function eval_run_summary(p_run_id uuid)
returns table (
  total          bigint,
  passed         bigint,
  mean_overall   double precision,
  min_overall    double precision,
  p50_overall    double precision,
  mean_latency   double precision
)
language sql
stable
as $$
  select
    count(*),
    count(*) filter (where passed),
    avg(overall),
    min(overall),
    percentile_cont(0.5) within group (order by overall),
    avg(latency_ms)
  from eval_results
  where run_id = p_run_id;
$$;
