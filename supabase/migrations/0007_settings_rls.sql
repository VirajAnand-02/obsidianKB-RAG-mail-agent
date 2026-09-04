-- 0007_settings_rls.sql
-- Runtime settings, encrypted provider credentials, and row level security.

set search_path = public, extensions;

-- ------------------------------------------------------------- settings ----
-- Runtime overrides for anything in .env. Resolution order at read time is:
--   app_settings row  ->  process.env  ->  hard-coded default
create table if not exists app_settings (
  key          text primary key,
  value        jsonb not null,
  -- Grouping for the settings UI: llm | embedding | chunking | retrieval |
  -- grounding | email | newsletter | eval
  category     text not null default 'general',
  description  text,
  updated_by   text,
  updated_at   timestamptz not null default now()
);

create index if not exists app_settings_category_idx on app_settings (category);

-- Provider API keys pasted into the dashboard. Encrypted at rest with
-- SETTINGS_ENCRYPTION_KEY (AES-256-GCM, done in application code) so a leaked
-- database backup does not leak the keys themselves.
create table if not exists provider_credentials (
  provider     text primary key,
  ciphertext   text not null,
  iv           text not null,
  auth_tag     text not null,
  -- Last 4 chars, for "sk-...a1b2" display without decrypting.
  hint         text,
  updated_by   text,
  updated_at   timestamptz not null default now()
);

create or replace function upsert_setting(
  p_key text, p_value jsonb, p_category text default 'general', p_actor text default null
)
returns app_settings
language plpgsql
as $$
declare
  result app_settings;
begin
  insert into app_settings (key, value, category, updated_by, updated_at)
  values (p_key, p_value, p_category, p_actor, now())
  on conflict (key) do update
    set value = excluded.value,
        category = excluded.category,
        updated_by = excluded.updated_by,
        updated_at = now()
  returning * into result;
  return result;
end;
$$;

-- ------------------------------------------------------------------ RLS ----
-- All server-side work uses the service role key, which bypasses RLS entirely.
-- These policies exist so that the browser's anon/authenticated key cannot read
-- vault contents or the review queue if it is ever used directly.

create or replace function is_admin()
returns boolean
language sql
stable
as $$
  select coalesce(
    (auth.jwt() ->> 'email') = any (
      select jsonb_array_elements_text(value)
      from app_settings
      where key = 'admin_emails'
    ),
    false
  );
$$;

comment on function is_admin is
  'True when the requesting JWT email is listed in the app_settings admin_emails array.';

do $$
declare
  t text;
begin
  foreach t in array array[
    'workspaces', 'vaults', 'notes', 'chunks', 'embedding_spaces',
    'email_threads', 'inbound_emails', 'outbound_emails', 'review_actions',
    'newsletter_subscribers', 'newsletter_issues',
    'ingest_runs', 'query_logs', 'eval_runs', 'eval_results',
    'app_settings', 'provider_credentials',
    'embeddings_384', 'embeddings_512', 'embeddings_768',
    'embeddings_1024', 'embeddings_1536', 'embeddings_3072'
  ]
  loop
    execute format('alter table %I enable row level security;', t);
    execute format('drop policy if exists admin_all on %I;', t);
    execute format(
      'create policy admin_all on %I for all to authenticated using (is_admin()) with check (is_admin());',
      t);
  end loop;
end;
$$;

-- Credentials are never readable from the browser, even by an admin session.
drop policy if exists admin_all on provider_credentials;

-- Unsubscribing must work for an anonymous visitor holding a valid token,
-- so it goes through a security-definer function rather than a table policy.
create or replace function unsubscribe_by_token(p_token text)
returns boolean
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  affected integer;
begin
  update newsletter_subscribers
     set status = 'unsubscribed', unsubscribed_at = now()
   where unsubscribe_token = p_token
     and status <> 'unsubscribed';
  get diagnostics affected = row_count;
  return affected > 0;
end;
$$;

revoke all on function unsubscribe_by_token(text) from public;
grant execute on function unsubscribe_by_token(text) to anon, authenticated;
