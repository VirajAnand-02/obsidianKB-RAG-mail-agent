-- 0009_drop_newsletter.sql
--
-- Removes the newsletter feature.
--
-- Obsi-Relay now does one thing: answer questions that arrive by email. The
-- scheduled digest, its subscriber list, and the cron endpoint that drove them
-- are gone, so the tables and functions that only existed to serve them are
-- dropped rather than left as dead schema.
--
-- `recent_notes` went with them: it existed solely to gather the notes an issue
-- was composed from, and nothing else calls it.
--
-- The `newsletter` value on the `message_kind` enum is deliberately left in
-- place. Removing an enum value requires rewriting the type and every column
-- using it, and an unused value costs nothing.

set search_path = public, extensions;

drop function if exists unsubscribe_by_token(text);
drop function if exists recent_notes(uuid, timestamptz, integer);

drop table if exists newsletter_issues;
drop table if exists newsletter_subscribers;
