-- 0005_email.sql
-- Inbound questions, drafted replies, the grounding gate's review queue,
-- and newsletter scheduling.

set search_path = public, extensions;

create type message_status as enum (
  'received',    -- inbound stored, nothing done yet
  'processing',  -- retrieval + drafting in flight
  'answered',    -- a reply was produced (see outbound_emails)
  'ignored',     -- filtered: autoreply, blocked sender, not a question
  'failed'
);

-- Where a draft ends up after the grounding gate.
create type delivery_status as enum (
  'draft',
  'pending_review',  -- grounding scored in the uncertain band
  'approved',        -- a human approved it; queued to send
  'rejected',        -- a human rejected it
  'blocked',         -- grounding said do not send
  'sending',
  'sent',
  'failed'
);

create type grounding_verdict as enum ('pass', 'review', 'block', 'skipped', 'error');
create type message_kind      as enum ('reply', 'newsletter', 'test');

-- ---------------------------------------------------------------- threads --
create table if not exists email_threads (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  participant   text not null,             -- the human on the other end
  subject       text,
  -- RFC 5322 Message-ID of the first message; used to thread replies correctly.
  root_message_id text,
  last_activity_at timestamptz not null default now(),
  created_at    timestamptz not null default now()
);

create index if not exists email_threads_participant_idx
  on email_threads (workspace_id, lower(participant));

-- ---------------------------------------------------------------- inbound --
create table if not exists inbound_emails (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  thread_id     uuid references email_threads(id) on delete set null,
  -- Provider event id. Unique so webhook retries cannot double-answer.
  provider_event_id text unique,
  message_id    text,
  in_reply_to   text,
  from_email    text not null,
  from_name     text,
  to_email      text,
  subject       text,
  text_body     text,
  html_body     text,
  -- The extracted question, with quoted history and signatures stripped.
  question      text,
  status        message_status not null default 'received',
  reason        text,
  raw           jsonb not null default '{}'::jsonb,
  received_at   timestamptz not null default now(),
  created_at    timestamptz not null default now()
);

create index if not exists inbound_from_idx   on inbound_emails (workspace_id, lower(from_email), received_at desc);
create index if not exists inbound_status_idx on inbound_emails (status, received_at desc);

-- --------------------------------------------------------------- outbound --
-- Every generated email, whether it sent, was queued for review, or was blocked.
-- This table is the review queue.
create table if not exists outbound_emails (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  vault_id      uuid references vaults(id) on delete set null,
  thread_id     uuid references email_threads(id) on delete set null,
  inbound_id    uuid references inbound_emails(id) on delete set null,
  kind          message_kind not null default 'reply',

  to_email      text not null,
  subject       text not null,
  body_markdown text not null,
  body_html     text,

  status        delivery_status not null default 'draft',

  -- Grounding gate output.
  grounding_verdict grounding_verdict not null default 'skipped',
  grounding_score   double precision,
  grounding         jsonb not null default '{}'::jsonb,

  -- Which chunks the answer was built from, for the reviewer's side-by-side.
  retrieval     jsonb not null default '[]'::jsonb,
  -- Provider/model/timing/token counts.
  generation    jsonb not null default '{}'::jsonb,

  provider_message_id text,
  error         text,

  reviewed_by   text,
  reviewed_at   timestamptz,
  review_note   text,
  -- Set when a human edited the draft before approving.
  edited_body_markdown text,

  scheduled_for timestamptz,
  sent_at       timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists outbound_status_idx  on outbound_emails (status, created_at desc);
create index if not exists outbound_review_idx  on outbound_emails (workspace_id, created_at desc)
  where status = 'pending_review';
create index if not exists outbound_thread_idx  on outbound_emails (thread_id, created_at);
create index if not exists outbound_to_idx      on outbound_emails (lower(to_email), created_at desc);

create trigger outbound_emails_updated_at
  before update on outbound_emails
  for each row execute function set_updated_at();

-- Audit trail for approvals. Kept separate so the decision history survives
-- later edits to the draft row itself.
create table if not exists review_actions (
  id            uuid primary key default gen_random_uuid(),
  outbound_id   uuid not null references outbound_emails(id) on delete cascade,
  action        text not null check (action in ('approve', 'reject', 'edit', 'resend', 'reopen')),
  actor         text not null,
  note          text,
  diff          jsonb,
  created_at    timestamptz not null default now()
);

create index if not exists review_actions_outbound_idx on review_actions (outbound_id, created_at);

-- ------------------------------------------------------------- newsletter --
create table if not exists newsletter_subscribers (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  email         text not null,
  name          text,
  status        text not null default 'active'
                check (status in ('active', 'unsubscribed', 'bounced', 'pending')),
  -- Only send issues touching these tags. Empty = everything.
  topic_tags    text[] not null default '{}',
  unsubscribe_token text not null default encode(gen_random_bytes(24), 'hex'),
  subscribed_at timestamptz not null default now(),
  unsubscribed_at timestamptz,
  unique (workspace_id, email)
);

create index if not exists subscribers_active_idx
  on newsletter_subscribers (workspace_id) where status = 'active';

create table if not exists newsletter_issues (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  vault_id      uuid references vaults(id) on delete set null,
  title         text not null,
  body_markdown text,
  body_html     text,
  status        delivery_status not null default 'draft',
  grounding_verdict grounding_verdict not null default 'skipped',
  grounding_score   double precision,
  grounding     jsonb not null default '{}'::jsonb,
  -- Notes that fed this issue.
  source_notes  jsonb not null default '[]'::jsonb,
  covers_since  timestamptz,
  scheduled_for timestamptz,
  sent_at       timestamptz,
  recipient_count integer not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create trigger newsletter_issues_updated_at
  before update on newsletter_issues
  for each row execute function set_updated_at();

-- ----------------------------------------------------------------- audit ---
create table if not exists ingest_runs (
  id           uuid primary key default gen_random_uuid(),
  vault_id     uuid not null references vaults(id) on delete cascade,
  status       text not null default 'running'
               check (status in ('running', 'completed', 'failed', 'cancelled')),
  trigger      text not null default 'manual',
  stats        jsonb not null default '{}'::jsonb,
  error        text,
  started_at   timestamptz not null default now(),
  finished_at  timestamptz
);

create index if not exists ingest_runs_vault_idx on ingest_runs (vault_id, started_at desc);

-- Every question the system answers, from any surface (email, playground, eval).
create table if not exists query_logs (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid references workspaces(id) on delete cascade,
  vault_id     uuid references vaults(id) on delete set null,
  source       text not null default 'email'
               check (source in ('email', 'playground', 'eval', 'api', 'newsletter')),
  question     text not null,
  answer       text,
  retrieval    jsonb not null default '[]'::jsonb,
  grounding    jsonb not null default '{}'::jsonb,
  provider     text,
  model        text,
  input_tokens integer,
  output_tokens integer,
  latency_ms   integer,
  error        text,
  created_at   timestamptz not null default now()
);

create index if not exists query_logs_created_idx on query_logs (created_at desc);
create index if not exists query_logs_source_idx  on query_logs (source, created_at desc);

-- Simple per-sender throttle, enforced in application code.
create or replace function replies_sent_today(p_workspace_id uuid, p_email text)
returns integer
language sql
stable
as $$
  select count(*)::integer
  from outbound_emails
  where workspace_id = p_workspace_id
    and lower(to_email) = lower(p_email)
    and kind = 'reply'
    and status in ('sent', 'sending', 'approved')
    and created_at >= now() - interval '1 day';
$$;
