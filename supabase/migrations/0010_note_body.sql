-- 0010_note_body.sql
--
-- Stores the normalised markdown body alongside each note.
--
-- Until now only chunks were persisted, and chunks are lossy for display: each
-- carries a "Note > H1 > H2" breadcrumb prefix and overlaps its neighbour, so
-- stitching them back together produces duplicated sentences and repeated
-- headings. Fine for retrieval, wrong for a preview pane.
--
-- The column is nullable: notes indexed before this migration simply have no
-- preview until the vault is re-ingested.

set search_path = public, extensions;

alter table notes add column if not exists body text;

comment on column notes.body is
  'Normalised markdown body, for display. Retrieval uses chunks, not this.';
