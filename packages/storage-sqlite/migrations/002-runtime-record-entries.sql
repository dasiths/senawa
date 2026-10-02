-- A run's append-only record collections, stored one entry per row.
--
-- Two collections -- amendment events and amendment records -- are append-only
-- and together are most of a run's records by size, so rewriting them whole on
-- every command made each write grow with the run's history. Held as rows, a
-- command appends only what it added, and a reader merges the rows back into
-- the records it has always seen.

CREATE TABLE runtime_record_entries (
  run_key TEXT NOT NULL REFERENCES runs(run_key) ON DELETE CASCADE,
  collection TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  entry_json TEXT NOT NULL,
  PRIMARY KEY (run_key, collection, ordinal)
) STRICT;
