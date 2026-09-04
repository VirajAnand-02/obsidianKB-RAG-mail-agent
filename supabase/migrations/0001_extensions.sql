-- 0001_extensions.sql
-- Base extensions. `vector` must exist before any embedding table is created.

create extension if not exists "pgcrypto"  with schema extensions;
create extension if not exists "vector"    with schema extensions;
create extension if not exists "pg_trgm"   with schema extensions;
create extension if not exists "unaccent"  with schema extensions;

-- Obsi-Relay keeps its own objects in `public` but relies on extension types
-- (vector, halfvec) resolving without a schema prefix.
set search_path = public, extensions;
