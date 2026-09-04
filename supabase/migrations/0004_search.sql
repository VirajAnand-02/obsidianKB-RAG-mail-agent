-- 0004_search.sql
--
-- Retrieval RPCs.
--
-- `hybrid_search` fuses pgvector similarity with Postgres full-text using
-- Reciprocal Rank Fusion. RRF is used instead of a weighted score blend because
-- cosine similarity and ts_rank live on incompatible scales -- normalising them
-- against each other needs per-corpus tuning, while RRF only needs rank order.
--
-- The query vector arrives as a text literal ('[0.1,0.2,...]') and is cast to
-- the active space's type at runtime, so one function serves every dimension.

set search_path = public, extensions;

create or replace function hybrid_search(
  p_vault_id        uuid,
  p_query_embedding text,
  p_query_text      text    default null,
  p_candidate_k     integer default 40,
  p_match_count     integer default 8,
  p_rrf_k           integer default 60,
  p_min_score       double precision default 0.0,
  p_space_id        uuid    default null,
  p_ef_search       integer default 100,
  p_include_private boolean default false
)
returns table (
  chunk_id        uuid,
  note_id         uuid,
  path            text,
  title           text,
  heading_path    text[],
  content         text,
  ordinal         integer,
  token_count     integer,
  tags            text[],
  note_updated_at timestamptz,
  similarity      double precision,
  fts_score       double precision,
  score           double precision
)
language plpgsql
stable
as $$
declare
  space    embedding_spaces;
  tbl      text;
  vec_type text;
begin
  if p_space_id is null then
    space := active_embedding_space();
  else
    select * into space from embedding_spaces where id = p_space_id;
  end if;

  if space is null then
    raise exception
      'No active embedding space. Run `npm run db:seed` or pick a model in Settings.';
  end if;

  tbl      := embedding_table_for(space.dimensions);
  vec_type := case when space.dimensions > 2000
                   then format('halfvec(%s)', space.dimensions)
                   else format('vector(%s)', space.dimensions) end;

  -- Widen the HNSW search beam for this statement only. Higher = better recall,
  -- more CPU. Must be >= the number of rows we want back.
  perform set_config('hnsw.ef_search', greatest(p_ef_search, p_candidate_k)::text, true);

  return query execute format($f$
    with vector_hits as (
      select
        e.chunk_id,
        row_number() over (order by e.embedding <=> $1::%1$s) as rank,
        1.0 - (e.embedding <=> $1::%1$s)                      as similarity
      from %2$I e
      where e.vault_id = $2
        and e.space_id = $3
      order by e.embedding <=> $1::%1$s
      limit $4
    ),
    fts_hits as (
      select
        c.id as chunk_id,
        row_number() over (order by ts_rank_cd(c.tsv, q.query) desc) as rank,
        ts_rank_cd(c.tsv, q.query)::double precision                 as fts_score
      from chunks c
      cross join websearch_to_tsquery('english', coalesce($5, '')) as q(query)
      where c.vault_id = $2
        and q.query is not null
        and c.tsv @@ q.query
      order by ts_rank_cd(c.tsv, q.query) desc
      limit $4
    ),
    fused as (
      select
        coalesce(v.chunk_id, f.chunk_id) as chunk_id,
        v.similarity,
        f.fts_score,
        coalesce(1.0 / ($6 + v.rank), 0.0)
          + coalesce(1.0 / ($6 + f.rank), 0.0) as rrf
      from vector_hits v
      full outer join fts_hits f on f.chunk_id = v.chunk_id
    )
    select
      c.id,
      c.note_id,
      n.path,
      n.title,
      c.heading_path,
      c.content,
      c.ordinal,
      c.token_count,
      n.tags,
      n.note_updated_at,
      fu.similarity,
      fu.fts_score,
      fu.rrf
    from fused fu
    join chunks c on c.id = fu.chunk_id
    join notes  n on n.id = c.note_id
    where n.deleted_at is null
      and ($8 or not n.is_private)
      -- Pure full-text hits have no similarity; the score floor only gates vectors.
      and (fu.similarity is null or fu.similarity >= $7)
    order by fu.rrf desc, fu.similarity desc nulls last
    limit $9
  $f$, vec_type, tbl)
  using
    p_query_embedding,   -- $1
    p_vault_id,          -- $2
    space.id,            -- $3
    p_candidate_k,       -- $4
    p_query_text,        -- $5
    p_rrf_k,             -- $6
    p_min_score,         -- $7
    p_include_private,   -- $8
    p_match_count;       -- $9
end;
$$;

comment on function hybrid_search is
  'Vector + full-text retrieval fused with Reciprocal Rank Fusion. Dispatches on the active embedding space dimension.';

-- ---------------------------------------------------------------------------
-- Neighbour-window expansion.
--
-- A chunk that answers a question is often mid-thought. Pulling the adjacent
-- chunks back in restores the surrounding sentences without another embedding
-- lookup, and measurably reduces "the note says more than the answer did".
-- ---------------------------------------------------------------------------
create or replace function chunk_neighbors(
  p_chunk_ids uuid[],
  p_window    integer default 1
)
returns table (
  chunk_id     uuid,
  note_id      uuid,
  path         text,
  title        text,
  heading_path text[],
  content      text,
  ordinal      integer,
  token_count  integer,
  is_seed      boolean
)
language sql
stable
as $$
  with seeds as (
    select c.id, c.note_id, c.ordinal
    from chunks c
    where c.id = any(p_chunk_ids)
  )
  select distinct on (n2.id)
    n2.id,
    n2.note_id,
    nt.path,
    nt.title,
    n2.heading_path,
    n2.content,
    n2.ordinal,
    n2.token_count,
    (n2.id = any(p_chunk_ids)) as is_seed
  from seeds s
  join chunks n2
    on n2.note_id = s.note_id
   and n2.ordinal between s.ordinal - p_window and s.ordinal + p_window
  join notes nt on nt.id = n2.note_id
  where nt.deleted_at is null
  order by n2.id, n2.ordinal;
$$;

-- ---------------------------------------------------------------------------
-- Recently changed notes, used to compose newsletter issues.
-- ---------------------------------------------------------------------------
create or replace function recent_notes(
  p_vault_id uuid,
  p_since    timestamptz,
  p_limit    integer default 20
)
returns table (
  note_id         uuid,
  path            text,
  title           text,
  tags            text[],
  word_count      integer,
  note_updated_at timestamptz,
  excerpt         text
)
language sql
stable
as $$
  select
    n.id,
    n.path,
    n.title,
    n.tags,
    n.word_count,
    n.note_updated_at,
    (
      select string_agg(c.content, E'\n\n' order by c.ordinal)
      from (
        select content, ordinal from chunks
        where note_id = n.id order by ordinal limit 2
      ) c
    ) as excerpt
  from notes n
  where n.vault_id = p_vault_id
    and n.deleted_at is null
    and not n.is_private
    and coalesce(n.note_updated_at, n.updated_at) >= p_since
  order by coalesce(n.note_updated_at, n.updated_at) desc
  limit p_limit;
$$;
