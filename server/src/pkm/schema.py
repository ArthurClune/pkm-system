# pattern: Functional Core
"""SQLite DDL for the PKM database. Executescript-able; owns all tables,
FTS5 indexes, and the triggers that keep FTS in sync with base tables.

Every statement is IF NOT EXISTS so this whole script is safe to run
against both a brand-new (empty) file and an already-populated database:
it is the single source of truth for the base schema, run by the importer
when it builds a fresh sqlite file from a Roam export, and by
server/db.py's init_db() at process startup so an empty data dir (no
import ever run) still gets working tables (pkm-cqu2). Additive tables use
replayable IF-NOT-EXISTS statements here. Columns also need a guarded
migration in server/db.py because SQLite has no ADD COLUMN IF NOT EXISTS;
client replicas use the generated schema hash to rebootstrap on change.

BASE_DDL contains the client-facing schema (replicated to all clients).
SERVER_DDL contains server-only tables and triggers (change journal, batch
idempotency, rename/merge rewrite records) that must not be installed on
clients (pkm-y8p0)."""

BASE_DDL = """
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
  updated_at  INTEGER,
  view_type   TEXT CHECK(view_type IN ('numbered','document'))
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

-- pkm-d31f: incoming ((uid)) index, the block-level analogue of refs.
-- No FK on target_block_uid: an unresolved ((uid)) is a legal state (it
-- renders unresolved), so dangling rows are permitted and simply never
-- match a count query. Rows are derived from block text at every write
-- choke point (ops_apply.py, localOps.ts, apply.ts) and NEVER shipped
-- over sync -- targets are uids, needing no id resolution, and the
-- extractor is parity-pinned (refs_parity.json).
CREATE TABLE IF NOT EXISTS block_refs(
  src_block_uid    TEXT NOT NULL REFERENCES blocks(uid) ON DELETE CASCADE,
  target_block_uid TEXT NOT NULL,
  PRIMARY KEY (src_block_uid, target_block_uid)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_block_refs_target ON block_refs(target_block_uid);

CREATE TABLE IF NOT EXISTS assets(
  sha256      TEXT PRIMARY KEY,
  filename    TEXT NOT NULL,
  mime        TEXT NOT NULL,
  size        INTEGER NOT NULL,
  created_at  INTEGER,
  -- pkm-zc0c: LLM-generated searchable description; all nullable.
  -- status is derived: described (description set) / failed
  -- (describe_error set) / pending (neither).
  description    TEXT,
  described_at   INTEGER,
  describe_error TEXT
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
# than folded into BASE_DDL's initial CREATE block) as a record of schema
# history, but it is just as idempotent and is executed as part of BASE_DDL
# below -- init_db() runs the whole of DDL (BASE_DDL + SERVER_DDL), not this
# alone, so both a fresh data dir and a pre-pkm-lhzd already-populated
# database converge on the same schema.
SIDEBAR_ENTRIES_DDL = """
CREATE TABLE IF NOT EXISTS sidebar_entries(
  id         INTEGER PRIMARY KEY,
  title      TEXT NOT NULL UNIQUE,
  order_idx  INTEGER NOT NULL
);
"""

BASE_DDL += SIDEBAR_ENTRIES_DDL

# Server-only DDL: the change journal (offline sync, pkm-y8p0) and batch
# idempotency records. Deliberately NOT part of BASE_DDL: the client
# replica is built from BASE_DDL alone -- installing these triggers there
# would grow an unused local journal on every upsert (spec section 3).
#
# Journal rows come from row-level triggers, not per-route code: a single
# op touches many rows beyond its target (sibling shifts, subtree moves,
# cascade deletes, implicit page creation), and triggers capture every
# affected row on every write path, current and future. Cascade deletes
# fire these triggers only when PRAGMA recursive_triggers=ON (db.py).
SERVER_DDL = """
CREATE TABLE IF NOT EXISTS changes(
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL CHECK(kind IN ('block','page','sidebar')),
  entity_id  TEXT NOT NULL,
  deleted    INTEGER NOT NULL DEFAULT 0
);

CREATE TRIGGER IF NOT EXISTS blocks_chg_ai AFTER INSERT ON blocks BEGIN
  INSERT INTO changes(kind, entity_id, deleted) VALUES ('block', new.uid, 0);
END;
CREATE TRIGGER IF NOT EXISTS blocks_chg_au AFTER UPDATE ON blocks BEGIN
  INSERT INTO changes(kind, entity_id, deleted) VALUES ('block', new.uid, 0);
END;
CREATE TRIGGER IF NOT EXISTS blocks_chg_ad AFTER DELETE ON blocks BEGIN
  INSERT INTO changes(kind, entity_id, deleted) VALUES ('block', old.uid, 1);
END;

CREATE TRIGGER IF NOT EXISTS pages_chg_ai AFTER INSERT ON pages BEGIN
  INSERT INTO changes(kind, entity_id, deleted)
  VALUES ('page', CAST(new.id AS TEXT), 0);
END;
CREATE TRIGGER IF NOT EXISTS pages_chg_au AFTER UPDATE ON pages BEGIN
  INSERT INTO changes(kind, entity_id, deleted)
  VALUES ('page', CAST(new.id AS TEXT), 0);
END;
CREATE TRIGGER IF NOT EXISTS pages_chg_ad AFTER DELETE ON pages BEGIN
  INSERT INTO changes(kind, entity_id, deleted)
  VALUES ('page', CAST(old.id AS TEXT), 1);
END;

CREATE TRIGGER IF NOT EXISTS sidebar_chg_ai AFTER INSERT ON sidebar_entries BEGIN
  INSERT INTO changes(kind, entity_id, deleted)
  VALUES ('sidebar', CAST(new.id AS TEXT), 0);
END;
CREATE TRIGGER IF NOT EXISTS sidebar_chg_au AFTER UPDATE ON sidebar_entries BEGIN
  INSERT INTO changes(kind, entity_id, deleted)
  VALUES ('sidebar', CAST(new.id AS TEXT), 0);
END;
CREATE TRIGGER IF NOT EXISTS sidebar_chg_ad AFTER DELETE ON sidebar_entries BEGIN
  INSERT INTO changes(kind, entity_id, deleted)
  VALUES ('sidebar', CAST(old.id AS TEXT), 1);
END;

CREATE TABLE IF NOT EXISTS applied_batches(
  batch_id     TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  response     TEXT NOT NULL,
  applied_at   INTEGER NOT NULL
);

-- What a rename, merge or the title migration did to one block's text
-- (pkm-x5w0): the sha256 of that text before and after, plus the one title
-- that moved. store.rewrite_snapshotted_blocks writes a row per changed
-- block per title it rewrote there, and ops_core.replay_title_rewrites
-- replays them over a stale device's update_text so an unsynced edit cannot
-- carry the old title back and re-create the page it was renamed away from.
-- Push-time resolution only: no journal trigger, never replicated, and
-- pruned to the last 30 days on every rewrite. No FK on uid -- a row
-- outliving its block is inert, and the block may be deleted and its edit
-- still arrive.
CREATE TABLE IF NOT EXISTS block_rewrites(
  uid        TEXT NOT NULL,
  base_hash  TEXT NOT NULL,
  after_hash TEXT NOT NULL,
  old_title  TEXT NOT NULL,
  new_title  TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_block_rewrites_uid
  ON block_rewrites(uid, base_hash);

-- Generation token (pkm-o9o5): a rebuilt database (importer swap) repopulates
-- the journal, so a stale client cursor usually sits BELOW latest_seq and the
-- since>latest reset check never fires -- a replica would silently pull from
-- mid-journal and permanently miss rows. Each database mints a random token
-- once; the sync endpoints echo it and a client re-bootstraps when it
-- changes. OR IGNORE keeps idempotent DDL replays from rotating the token.
CREATE TABLE IF NOT EXISTS sync_meta(
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT OR IGNORE INTO sync_meta(key, value)
  SELECT 'db_generation', lower(hex(randomblob(16)));
INSERT OR IGNORE INTO sync_meta(key, value)
VALUES ('plain_space_title_canonicalization', '0');
"""

DDL = BASE_DDL + SERVER_DDL
