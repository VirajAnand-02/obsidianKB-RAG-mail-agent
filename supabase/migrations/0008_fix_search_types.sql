-- 0008_fix_search_types.sql
--
-- Fixes a return-type mismatch in `hybrid_search`.
--
-- The RRF score was built as `1.0 / (p_rrf_k + rank)`. `row_number()` returns
-- bigint and `1.0` is a numeric literal, so the division produced `numeric`,
-- while the function declares `score double precision`. Postgres only discovers
-- this when the query actually runs, failing with:
--
--   structure of query does not match function result type
--
-- Every value returned from the dynamic query is now cast explicitly, so a
-- literal's inferred type can no longer drift away from the declared signature.

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
        row_number() over (order by e.embedding <=> $1::%1$s)          as rank,
        (1.0 - (e.embedding <=> $1::%1$s))::double precision           as similarity
      from %2$I e
      where e.vault_id = $2
        and e.space_id = $3
      order by e.embedding <=> $1::%1$s
      limit $4
    ),
    fts_hits as (
      select
        c.id as chunk_id,
        row_number() over (order by ts_rank_cd(c.tsv, q.query) desc)   as rank,
        ts_rank_cd(c.tsv, q.query)::double precision                   as fts_score
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
        (
          coalesce(1.0 / ($6::double precision + v.rank), 0.0)
          + coalesce(1.0 / ($6::double precision + f.rank), 0.0)
        )::double precision as rrf
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
      c.ordinal::integer,
      c.token_count::integer,
      n.tags,
      n.note_updated_at,
      fu.similarity::double precision,
      fu.fts_score::double precision,
      fu.rrf::double precision
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
