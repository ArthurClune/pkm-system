// pattern: Imperative Shell
// Client-only replica tables layered on the exported server base schema
// (spec section 3). pending_ops is the durable offline queue -- its shape
// (id, batch_id, ops_json) is migration-stable: a newer client must always
// be able to extract wire-format JSON from an older database, so changes
// here must be additive only (spec section 6 guardrail).

import { BASE_SCHEMA } from "./baseSchema.gen";
import type { ReplicaDb } from "./db";
import { getMeta, setMeta } from "./meta";
import { sha256Hex } from "./sha256";

export const CLIENT_DDL = `
CREATE TABLE IF NOT EXISTS sync_client_meta(
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pending_ops(
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id TEXT NOT NULL,
  ops_json TEXT NOT NULL,
  poisoned INTEGER NOT NULL DEFAULT 0,
  error    TEXT
);

CREATE TABLE IF NOT EXISTS effect_ledger(
  batch_id        TEXT NOT NULL,
  uid             TEXT NOT NULL,
  order_delta     INTEGER NOT NULL DEFAULT 0,
  base_page_id    INTEGER,
  base_updated_at INTEGER,
  row_json        TEXT,
  PRIMARY KEY (batch_id, uid)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_effect_ledger_uid ON effect_ledger(uid);

CREATE TABLE IF NOT EXISTS replay_log(
  id INTEGER PRIMARY KEY AUTOINCREMENT, batch_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('block','page')), key TEXT NOT NULL,
  pre_json TEXT, pre_page_id INTEGER, UNIQUE(batch_id, kind, key));
CREATE INDEX IF NOT EXISTS idx_replay_log_key ON replay_log(kind, key);
CREATE TABLE IF NOT EXISTS replay_log_refs(
  log_id INTEGER NOT NULL REFERENCES replay_log(id) ON DELETE CASCADE,
  target_page_id INTEGER NOT NULL, kind TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_replay_log_refs_log ON replay_log_refs(log_id);
CREATE TABLE IF NOT EXISTS replay_batches(
  batch_id TEXT PRIMARY KEY, enqueued_ms INTEGER NOT NULL);
`;

/** Identifies the exact DDL a replica file was built with; a mismatch on
 * open triggers the flush-then-rebootstrap recovery (spec section 6). */
export const SCHEMA_VERSION = sha256Hex(BASE_SCHEMA + CLIENT_DDL);

export function installSchema(db: ReplicaDb): void {
  db.exec(BASE_SCHEMA);
  db.exec(CLIENT_DDL);
  if (getMeta(db, "schema_version") === null) {
    setMeta(db, "schema_version", SCHEMA_VERSION);
  }
}
