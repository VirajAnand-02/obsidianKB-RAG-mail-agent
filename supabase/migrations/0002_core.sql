-- 0002_core.sql
-- Core knowledge-base tables: workspace -> vault -> note -> chunk.

set search_path = public, extensions;

-- ---------------------------------------------------------------- helpers --
create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- -------------------------------------------------------------- workspace --
-- Single-tenant today, but every row is keyed by workspace so enabling
-- multi-tenancy later is an RLS change rather than a migration of every table.
create table if not exists workspaces (
  id          uuid primary key default gen_random_uuid(),
  name        text        not null,
  slug        text        not null unique,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create trigger workspaces_updated_at
  before update on workspaces
  for each row execute function set_updated_at();

-- ------------------------------------------------------------------ vault --
create type vault_source as enum ('zip', 'folder', 'git', 'seed');
create type vault_status as enum ('pending', 'uploading', 'ingesting', 'ready', 'failed');

create table if not exists vaults (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  name          text not null,
  description   text,
  source        vault_source not null default 'zip',
  -- Object key inside SUPABASE_STORAGE_BUCKET for the uploaded archive.
  archive_path  text,
  archive_bytes bigint,
  status        vault_status not null default 'pending',
  is_default    boolean not null default false,
  stats         jsonb not null default '{}'::jsonb,
  error         text,
  last_ingested_at timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists vaults_workspace_idx on vaults (workspace_id);
-- At most one default vault per workspace.
create unique index if not exists vaults_one_default_idx
  on vaults (workspace_id) where is_default;

create trigger vaults_updated_at
  before update on vaults
  for each row execute function set_updated_at();

-- ------------------------------------------------------------------- note --
create table if not exists notes (
  id            uuid primary key default gen_random_uuid(),
  vault_id      uuid not null references vaults(id) on delete cascade,
  -- Vault-relative POSIX path, e.g. "Areas/Engineering/Retry policy.md".
  path          text not null,
  title         text not null,
  frontmatter   jsonb not null default '{}'::jsonb,
  tags          text[] not null default '{}',
  -- Outgoing [[wikilinks]], resolved to note paths where possible.
  links         text[] not null default '{}',
  aliases       text[] not null default '{}',
  -- sha256 of the raw file. Lets re-ingest skip unchanged notes entirely.
  content_hash  text not null,
  word_count    integer not null default 0,
  token_count   integer not null default 0,
  -- Excluded from retrieval because of privacy frontmatter/tags.
  is_private    boolean not null default false,
  -- Storage key for the raw markdown body.
  body_path     text,
  note_created_at timestamptz,
  note_updated_at timestamptz,
  deleted_at    timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (vault_id, path)
);

create index if not exists notes_vault_idx        on notes (vault_id) where deleted_at is null;
create index if not exists notes_tags_idx         on notes using gin (tags);
create index if not exists notes_frontmatter_idx  on notes using gin (frontmatter);
create index if not exists notes_updated_idx      on notes (vault_id, note_updated_at desc);
create index if not exists notes_title_trgm_idx   on notes using gin (title gin_trgm_ops);

create trigger notes_updated_at
  before update on notes
  for each row execute function set_updated_at();

-- ------------------------------------------------------------------ chunk --
create table if not exists chunks (
  id            uuid primary key default gen_random_uuid(),
  note_id       uuid not null references notes(id) on delete cascade,
  vault_id      uuid not null references vaults(id) on delete cascade,
  -- 0-based position within the note; used for neighbour-window expansion.
  ordinal       integer not null,
  -- ["Note title", "H1", "H2"] breadcrumb, prepended to the embedded text.
  heading_path  text[] not null default '{}',
  content       text not null,
  token_count   integer not null default 0,
  char_start    integer not null default 0,
  char_end      integer not null default 0,
  content_hash  text not null,
  created_at    timestamptz not null default now(),
  unique (note_id, ordinal)
);

create index if not exists chunks_note_idx  on chunks (note_id, ordinal);
create index if not exists chunks_vault_idx on chunks (vault_id);
create index if not exists chunks_hash_idx  on chunks (content_hash);

-- Postgres marks `array_to_string` STABLE rather than IMMUTABLE, because for an
-- arbitrary element type it depends on that type's output function. For `text[]`
-- the result is genuinely deterministic, but a generated column will not accept
-- a STABLE expression, so the join is wrapped in an immutable function of a
-- concrete type.
create or replace function heading_path_to_text(p_path text[])
returns text
language sql
immutable
parallel safe
strict
as $$
  select array_to_string(p_path, ' ');
$$;

comment on function heading_path_to_text is
  'Immutable text[] join, so the chunks.tsv generated column can index heading breadcrumbs.';

-- Full-text side of hybrid retrieval. Heading breadcrumb is weighted above the
-- body so a heading match outranks an incidental body mention.
alter table chunks
  add column if not exists tsv tsvector
  generated always as (
    setweight(
      to_tsvector('english', coalesce(heading_path_to_text(heading_path), '')), 'A'
    ) ||
    setweight(to_tsvector('english', coalesce(content, '')), 'B')
  ) stored;

create index if not exists chunks_tsv_idx on chunks using gin (tsv);
