# pattern: Functional Core
"""SQLite DDL for the PKM database. Executescript-able; owns all tables,
FTS5 indexes, and the triggers that keep FTS in sync with base tables."""

DDL = """
CREATE TABLE pages(
  id          INTEGER PRIMARY KEY,
  title       TEXT NOT NULL UNIQUE,
  created_at  INTEGER,
  updated_at  INTEGER
);

CREATE TABLE blocks(
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
CREATE INDEX idx_blocks_page ON blocks(page_id);
CREATE INDEX idx_blocks_parent ON blocks(parent_uid);

CREATE TABLE refs(
  src_block_uid  TEXT NOT NULL REFERENCES blocks(uid) ON DELETE CASCADE,
  target_page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL CHECK(kind IN ('link','tag','attribute')),
  PRIMARY KEY (src_block_uid, target_page_id, kind)
) WITHOUT ROWID;
CREATE INDEX idx_refs_target ON refs(target_page_id);

CREATE TABLE assets(
  sha256      TEXT PRIMARY KEY,
  filename    TEXT NOT NULL,
  mime        TEXT NOT NULL,
  size        INTEGER NOT NULL,
  created_at  INTEGER
);

CREATE VIRTUAL TABLE blocks_fts USING fts5(text, content='blocks');
CREATE TRIGGER blocks_fts_ai AFTER INSERT ON blocks BEGIN
  INSERT INTO blocks_fts(rowid, text) VALUES (new.rowid, new.text);
END;
CREATE TRIGGER blocks_fts_ad AFTER DELETE ON blocks BEGIN
  INSERT INTO blocks_fts(blocks_fts, rowid, text)
  VALUES ('delete', old.rowid, old.text);
END;
CREATE TRIGGER blocks_fts_au AFTER UPDATE OF text ON blocks BEGIN
  INSERT INTO blocks_fts(blocks_fts, rowid, text)
  VALUES ('delete', old.rowid, old.text);
  INSERT INTO blocks_fts(rowid, text) VALUES (new.rowid, new.text);
END;

CREATE VIRTUAL TABLE pages_fts USING fts5(title, content='pages', content_rowid='id');
CREATE TRIGGER pages_fts_ai AFTER INSERT ON pages BEGIN
  INSERT INTO pages_fts(rowid, title) VALUES (new.id, new.title);
END;
CREATE TRIGGER pages_fts_ad AFTER DELETE ON pages BEGIN
  INSERT INTO pages_fts(pages_fts, rowid, title)
  VALUES ('delete', old.id, old.title);
END;
CREATE TRIGGER pages_fts_au AFTER UPDATE OF title ON pages BEGIN
  INSERT INTO pages_fts(pages_fts, rowid, title)
  VALUES ('delete', old.id, old.title);
  INSERT INTO pages_fts(rowid, title) VALUES (new.id, new.title);
END;
"""
