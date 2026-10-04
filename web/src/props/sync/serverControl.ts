// pattern: Imperative Shell
// The harness's handle on the proptest server: the session cookie and the
// /__proptest/* control routes (server/tooling/proptest/sync_server.py).
import type { BatchId, SyncSeq } from "../../api/brands";
import type { Changes, Snapshot } from "../../replica/apply";
import { BASE_URL, PASSWORD } from "./env";

export interface ServerControl {
  cookie: string;
  reset(): Promise<void>;
  setClock(ms: number): Promise<void>;
  rotateGeneration(): Promise<void>;
  /** applied_batches in commit order. */
  applied(): Promise<{ batch_id: BatchId; applied_at: number }[]>;
  snapshot(): Promise<Snapshot>;
  /** The journal's latest seq. */
  latestSeq(): Promise<SyncSeq>;
  /** POST /api/ops with this exact body, for replaying a recorded request. */
  postRaw(body: string): Promise<Response>;
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
      (await (await call("/__proptest/applied")).json()) as
        { batch_id: BatchId; applied_at: number }[],
    snapshot: async () =>
      (await (await call("/api/sync/snapshot")).json()) as Snapshot,
    latestSeq: async () => {
      const feed = (await (await call(
        `/api/sync/changes?since=${BEYOND_ANY_SEQ}`)).json()) as Changes;
      return feed.latest_seq;
    },
    postRaw: (body) => fetch(`${BASE_URL}/api/ops`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body,
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
