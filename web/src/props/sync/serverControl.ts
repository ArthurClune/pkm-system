// pattern: Imperative Shell
// The harness's handle on the proptest server: the session cookie and the
// /__proptest/* control routes (server/tooling/proptest/sync_server.py).
import type { BatchId, CanonicalTitle, BlockUid, RawTitle, SyncSeq } from "../../api/brands";
import type { BlockOp } from "../../api/ops";
import type { Changes, Snapshot } from "../../replica/apply";
import { BASE_URL, PASSWORD } from "./env";
import {
  parseAppliedLog, parseChanges, parseConflicts, parseDeletes, parseEcho, parseRenames,
  parseSnapshot,
} from "./wire";

/** One page retitle, in commit order: the batch it followed (null: before
 * every batch) and the server clock it ran at. */
export interface RenameRecord {
  old_title: CanonicalTitle;
  new_title: CanonicalTitle;
  after_batch_id: BatchId | null;
  at: number;
  /** Position among renames and deletes together, in commit order. */
  ord: number;
}

/** One recorded user page delete, in commit order: the batch it followed
 * (null: before every batch), the journal seq it was made at, the server
 * clock it ran at, and the uids of the blocks it removed. */
export interface DeleteRecord {
  title: CanonicalTitle;
  seq: SyncSeq;
  after_batch_id: BatchId | null;
  at: number;
  ord: number;
  uids: BlockUid[];
}

/** One daily-note conflict header the run wrote, in commit order: its uid,
 * its text as written (before any later rewrite of it), and the batch that
 * wrote it (null when no applied batch followed the write, which only a
 * route other than POST /api/ops could do). */
export interface ConflictRecord {
  header_uid: BlockUid;
  text: string;
  batch_id: BatchId | null;
}

export interface ServerControl {
  cookie: string;
  reset(): Promise<void>;
  setClock(ms: number): Promise<void>;
  rotateGeneration(): Promise<void>;
  /** applied_batches in commit order. */
  applied(): Promise<{ batch_id: BatchId; applied_at: number }[]>;
  /** Every page retitle, in commit order. */
  renames(): Promise<RenameRecord[]>;
  /** Every recorded page delete, in commit order. */
  deletes(): Promise<DeleteRecord[]>;
  /** Every conflict header written, in commit order. */
  conflicts(): Promise<ConflictRecord[]>;
  snapshot(): Promise<Snapshot>;
  /** The ops of the last broadcast frame since the previous take or reset
   * (null: none), then forgets them. */
  takeEcho(): Promise<BlockOp[] | null>;
  /** While on, recorded echoes lose the page_title of every move that names
   * one: a deliberate corruption for checking that a suite notices. */
  setEchoTeeth(on: boolean): Promise<void>;
  /** While on, every batch is stale for no title, so a stale create or link
   * re-creates a deleted page: a deliberate corruption for the oracle's
   * teeth. A reset turns it off. */
  setStaleTeeth(on: boolean): Promise<void>;
  /** While on, a hashed edit whose replay of a rename or delete changed the
   * text it wrote records no rewrite rows for it, so the same device's next
   * edit of the block conflicts: a deliberate corruption for the oracle's
   * teeth. A reset turns it off. */
  setRewriteTeeth(on: boolean): Promise<void>;
  /** With `off`, POST /api/ops judges no text against the length and
   * nesting limits, so it stores a text enqueueBatch refuses: a deliberate
   * corruption for the ops suite's teeth. A reset turns the limits back
   * on. */
  setLimitTeeth(off: boolean): Promise<void>;
  /** GET /api/sync/changes?since=. */
  changes(since: SyncSeq): Promise<Changes>;
  /** The journal's latest seq. */
  latestSeq(): Promise<SyncSeq>;
  /** POST /api/ops with this exact body, for replaying a recorded request. */
  postRaw(body: string): Promise<Response>;
  /** POST the rename route as the SPA does (no merge), for replaying a
   * recorded rename. */
  postRename(from: string, to: string): Promise<Response>;
  /** DELETE the page as the SPA does, for replaying a recorded delete. */
  postDelete(title: RawTitle): Promise<Response>;
  /** The same control whose every request is aborted when `signal` fires, so
   * a request already on the wire cannot commit after its owner gave up. */
  withSignal(signal: AbortSignal): ServerControl;
}

// Past any real seq: the changes route answers a cursor beyond its journal
// with an empty reset payload that still names latest_seq.
const BEYOND_ANY_SEQ = Number.MAX_SAFE_INTEGER;

async function login(): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`proptest login failed: ${res.status}`);
  const cookie = (res.headers.getSetCookie()[0] ?? "").split(";")[0];
  if (!cookie) throw new Error("proptest login set no cookie");
  return cookie;
}

async function checked(res: Response, what: string): Promise<Response> {
  if (!res.ok) {
    throw new Error(`${what} failed: ${res.status} ${await res.text()}`);
  }
  return res;
}

function control(cookie: string, signal?: AbortSignal): ServerControl {
  const call = async (path: string, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    headers.set("cookie", cookie);
    return checked(await fetch(`${BASE_URL}${path}`, { ...init, headers, signal }), path);
  };
  const post = (path: string, body?: unknown): Promise<Response> => call(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    cookie,
    reset: async () => { await post("/__proptest/reset"); },
    setClock: async (ms) => { await post("/__proptest/clock", { ms }); },
    rotateGeneration: async () => { await post("/__proptest/rotate-generation"); },
    applied: async () =>
      parseAppliedLog(await (await call("/__proptest/applied")).json()),
    renames: async () => parseRenames(await (await call("/__proptest/renames")).json()),
    deletes: async () => parseDeletes(await (await call("/__proptest/deletes")).json()),
    conflicts: async () =>
      parseConflicts(await (await call("/__proptest/conflicts")).json()),
    snapshot: async () => parseSnapshot(await (await call("/api/sync/snapshot")).json()),
    takeEcho: async () => parseEcho(await (await post("/__proptest/echo/take")).json()),
    setEchoTeeth: async (on) => {
      await post("/__proptest/echo/teeth", { drop_cross_page_title: on });
    },
    setStaleTeeth: async (on) => { await post("/__proptest/stale/teeth", { empty: on }); },
    setRewriteTeeth: async (on) => {
      await post("/__proptest/rewrites/teeth", { drop_replayed: on });
    },
    setLimitTeeth: async (off) => { await post("/__proptest/limits/teeth", { off }); },
    changes: async (since) =>
      parseChanges(await (await call(`/api/sync/changes?since=${since}`)).json()),
    latestSeq: async () => {
      const feed = parseChanges(await (await call(
        `/api/sync/changes?since=${BEYOND_ANY_SEQ}`)).json());
      return feed.latest_seq;
    },
    postRaw: (body) => fetch(`${BASE_URL}/api/ops`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body,
      signal,
    }),
    postRename: (from, to) => fetch(
      `${BASE_URL}/api/page/${encodeURIComponent(from)}/rename`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ new_title: to, allow_merge: false }),
        signal,
      }),
    postDelete: (title: RawTitle) => fetch(
      `${BASE_URL}/api/page/${encodeURIComponent(title)}`, {
        method: "DELETE",
        headers: { cookie },
        signal,
      }),
    withSignal: (next) => control(cookie, next),
  };
}

let connected: Promise<ServerControl> | null = null;

/** Logs in once per module instance. The cookie must be issued while the
 * server clock is at START_MS (cookies more than five minutes in the future
 * are refused, and every reset returns the clock there): a first login may
 * meet a clock an earlier test file moved, so it only buys the reset that
 * returns the clock to START_MS, and the second login is the one kept. */
export function connectServer(): Promise<ServerControl> {
  connected ??= (async () => {
    await control(await login()).reset();
    return control(await login());
  })();
  return connected;
}
