-- 0003_embeddings.sql
--
-- Dimension-agnostic vector storage.
--
-- Obsi-Relay lets the admin switch embedding provider at runtime (Mistral 1024,
-- Gemini/nomic 768, MiniLM 384, OpenAI 1536/3072...). A single `vector(N)`
-- column would hard-code one model into the schema, so instead each supported
-- dimension gets its own table and its own HNSW index, and an
-- `embedding_spaces` registry says which (provider, model, dim) is live.
--
-- Switching models is then a backfill (`npm run db:reembed`), never a migration,
-- and vectors from the old space stay queryable until you drop them.
--
-- pgvector caps HNSW at 2000 dims for `vector`, so 3072-dim models are stored as
-- `halfvec` (fp16), which indexes up to 4096 dims and costs ~0 recall in practice.

set search_path = public, extensions;

create table if not exists embedding_spaces (
  id          uuid primary key default gen_random_uuid(),
  provider    text    not null,
  model       text    not null,
  dimensions  integer not null,
  -- Asymmetric models (e5/bge/nomic) need these prefixes at embed time.
  doc_prefix    text not null default '',
  query_prefix  text not null default '',
  is_active   boolean not null default false,
  notes       text,
  created_at  timestamptz not null default now(),
  unique (provider, model, dimensions)
);

-- Exactly one active space at a time; retrieval reads whichever it is.
create unique index if not exists embedding_spaces_one_active_idx
  on embedding_spaces ((true)) where is_active;

comment on table embedding_spaces is
  'Registry of (provider, model, dimensions) embedding configurations. Exactly one is active.';

-- ---------------------------------------------------------------------------
-- Per-dimension embedding tables, created from a single template.
-- ---------------------------------------------------------------------------
do $$
declare
  dims       integer;
  vec_type   text;
  tbl        text;
  hnsw_m     integer := 16;
  hnsw_efc   integer := 64;
begin
  foreach dims in array array[384, 512, 768, 1024, 1536, 3072]
  loop
    tbl := format('embeddings_%s', dims);
    -- `vector` maxes out at 2000 dims for HNSW; use fp16 `halfvec` beyond that.
    vec_type := case when dims > 2000
                     then format('halfvec(%s)', dims)
                     else format('vector(%s)', dims) end;

    execute format($f$
      create table if not exists %I (
        chunk_id   uuid not null references chunks(id) on delete cascade,
        space_id   uuid not null references embedding_spaces(id) on delete cascade,
        vault_id   uuid not null references vaults(id) on delete cascade,
        embedding  %s not null,
        created_at timestamptz not null default now(),
        primary key (chunk_id, space_id)
      );
    $f$, tbl, vec_type);

    -- Cosine distance matches how every supported provider normalises output.
    execute format($f$
      create index if not exists %I on %I
      using hnsw (embedding %s) with (m = %s, ef_construction = %s);
    $f$,
      tbl || '_hnsw_idx', tbl,
      case when dims > 2000 then 'halfvec_cosine_ops' else 'vector_cosine_ops' end,
      hnsw_m, hnsw_efc);

    -- Retrieval always filters by vault before ranking.
    execute format(
      'create index if not exists %I on %I (vault_id, space_id);',
      tbl || '_scope_idx', tbl);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- Resolves the physical table for a dimension count.
create or replace function embedding_table_for(p_dimensions integer)
returns text
language plpgsql
immutable
as $$
begin
  if p_dimensions not in (384, 512, 768, 1024, 1536, 3072) then
    raise exception
      'Unsupported embedding dimension %. Add it to 0003_embeddings.sql to use this model.',
      p_dimensions;
  end if;
  return format('embeddings_%s', p_dimensions);
end;
$$;

-- Returns the live embedding space, or null when none has been configured yet.
create or replace function active_embedding_space()
returns embedding_spaces
language sql
stable
as $$
  select * from embedding_spaces where is_active limit 1;
$$;

-- Flips the active space atomically (the partial unique index forbids two).
create or replace function activate_embedding_space(p_space_id uuid)
returns embedding_spaces
language plpgsql
as $$
declare
  result embedding_spaces;
begin
  update embedding_spaces set is_active = false where is_active and id <> p_space_id;
  update embedding_spaces set is_active = true  where id = p_space_id
  returning * into result;

  if result is null then
    raise exception 'Embedding space % not found', p_space_id;
  end if;
  return result;
end;
$$;

-- How much of the active space still needs embedding. Drives the ingest UI.
create or replace function embedding_coverage(p_vault_id uuid)
returns table (
  space_id        uuid,
  provider        text,
  model           text,
  dimensions      integer,
  total_chunks    bigint,
  embedded_chunks bigint
)
language plpgsql
stable
as $$
declare
  space embedding_spaces;
  tbl   text;
begin
  space := active_embedding_space();
  if space is null then
    return;
  end if;
  tbl := embedding_table_for(space.dimensions);

  return query execute format($f$
    select
      %L::uuid, %L::text, %L::text, %s::integer,
      (select count(*) from chunks c where c.vault_id = %L::uuid),
      (select count(*) from %I e where e.vault_id = %L::uuid and e.space_id = %L::uuid)
  $f$, space.id, space.provider, space.model, space.dimensions,
       p_vault_id, tbl, p_vault_id, space.id);
end;
$$;
