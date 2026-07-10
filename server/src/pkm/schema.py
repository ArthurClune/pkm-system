# pattern: Functional Core
"""SQLite DDL for the PKM database. Executescript-able; owns all tables,
FTS5 indexes, and the triggers that keep FTS in sync with base tables.

Every statement is IF NOT EXISTS so this whole script is safe to run
against both a brand-new (empty) file and an already-populated database:
it is the single source of truth for the base schema, run by the importer
when it builds a fresh sqlite file from a Roam export, and by
server/db.py's init_db() at process startup so an empty data dir (no
import ever run) still gets working tables (pkm-cqu2). There is no
migration runner in this project -- any future column/table addition
needs to be its own idempotent statement appended here so init_db() picks
it up on existing (already-populated) databases with no manual step."""

DDL = """
CREATE TABLE IF NOT EXISTS pages(
  id          INTEGER PRIMARY KEY,
  title       TEXT NOT NULL UNIQUE,
  created_at  INTEGER,
  updated_at  INTEGER
);

-- ON DELETE CASCADE requires PRAGMA foreign_keys=ON per connection (SQLite default is OFF)
CREATE TABLE IF NOT EXISTS blocks(
  uid         TEXT PRIMARY KEY,
  page_id     INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  parent_uid  TEXT REFERENCES blocks(uid) ON DELETE CASCADE,
  order_idx   INTEGER NOT NULL,
  text        TEXT NOT NULL,
  heading     INTEGER,
  collapsed   INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER,
  updated_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_blocks_page ON blocks(page_id);
CREATE INDEX IF NOT EXISTS idx_blocks_parent ON blocks(parent_uid);

CREATE TABLE IF NOT EXISTS refs(
  src_block_uid  TEXT NOT NULL REFERENCES blocks(uid) ON DELETE CASCADE,
  target_page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL CHECK(kind IN ('link','tag','attribute')),
  PRIMARY KEY (src_block_uid, target_page_id, kind)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_refs_target ON refs(target_page_id);

CREATE TABLE IF NOT EXISTS assets(
  sha256      TEXT PRIMARY KEY,
  filename    TEXT NOT NULL,
  mime        TEXT NOT NULL,
  size        INTEGER NOT NULL,
  created_at  INTEGER
);

-- keyed by blocks' implicit rowid: never VACUUM without rebuilding FTS ('rebuild' command)
CREATE VIRTUAL TABLE IF NOT EXISTS blocks_fts USING fts5(text, content='blocks');
CREATE TRIGGER IF NOT EXISTS blocks_fts_ai AFTER INSERT ON blocks BEGIN
  INSERT INTO blocks_fts(rowid, text) VALUES (new.rowid, new.text);
END;
CREATE TRIGGER IF NOT EXISTS blocks_fts_ad AFTER DELETE ON blocks BEGIN
  INSERT INTO blocks_fts(blocks_fts, rowid, text)
  VALUES ('delete', old.rowid, old.text);
END;
CREATE TRIGGER IF NOT EXISTS blocks_fts_au AFTER UPDATE OF text ON blocks BEGIN
  INSERT INTO blocks_fts(blocks_fts, rowid, text)
  VALUES ('delete', old.rowid, old.text);
  INSERT INTO blocks_fts(rowid, text) VALUES (new.rowid, new.text);
END;

CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(title, content='pages', content_rowid='id');
CREATE TRIGGER IF NOT EXISTS pages_fts_ai AFTER INSERT ON pages BEGIN
  INSERT INTO pages_fts(rowid, title) VALUES (new.id, new.title);
END;
CREATE TRIGGER IF NOT EXISTS pages_fts_ad AFTER DELETE ON pages BEGIN
  INSERT INTO pages_fts(pages_fts, rowid, title)
  VALUES ('delete', old.id, old.title);
END;
CREATE TRIGGER IF NOT EXISTS pages_fts_au AFTER UPDATE OF title ON pages BEGIN
  INSERT INTO pages_fts(pages_fts, rowid, title)
  VALUES ('delete', old.id, old.title);
  INSERT INTO pages_fts(rowid, title) VALUES (new.id, new.title);
END;
"""

# Added after the tables above shipped; kept as its own statement (rather
# than folded into DDL's initial CREATE block) as a record of schema
# history, but it is just as idempotent and is executed as part of DDL
# below -- init_db() runs the whole of DDL, not this alone, so both a
# fresh data dir and a pre-pkm-lhzd already-populated database converge
# on the same schema.
SIDEBAR_ENTRIES_DDL = """
CREATE TABLE IF NOT EXISTS sidebar_entries(
  id         INTEGER PRIMARY KEY,
  title      TEXT NOT NULL UNIQUE,
  order_idx  INTEGER NOT NULL
);
"""

DDL += SIDEBAR_ENTRIES_DDL
