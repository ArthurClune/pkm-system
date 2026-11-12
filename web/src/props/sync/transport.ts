// pattern: Imperative Shell
// One simulated client's network: the queue's `post` and replicaSync's
// `fetchJson` both go through it, to the real proptest server, with the
// session cookie, one-shot faults and an optional deliberately broken mode.
//
// Errors mirror apiFetch (api/client.ts): a non-2xx answer throws ApiError,
// and a request that never got an answer throws the TypeError a failed
// fetch throws. apiFetch's read deadline is not reproduced: the server is
// local, and a hang would show as the property's own timeout.
//
// apiFetch's progress and stall bound are, for the answer as this transport
// delivers it: `onProgress` once when a body arrives, or once per piece of a
// paced one, and `stallMs` of silence in a paced answer rejects with
// StalledReadError. The real exchange's own latency is not timed: the
// harness scales the stall bound down with its lease, and the local server's
// latency does not scale with it.
import { ApiError, type ApiFetchOptions, StalledReadError } from "../../api/client";
import type { BatchId } from "../../api/brands";
import type { OpBatch, OpsAck } from "../../api/payloads";
import { BASE_URL } from "./env";
import type { ServerControl } from "./serverControl";
import { parseChanges, parseOpsAck, readBatchHead, record } from "./wire";
import { seqOf } from "../../test-helpers";

/** One-shot faults, each consumed by the next request of its kind. A
 * snapshot5xx answers the next snapshot fetch with a 503 the server never
 * saw. A slowSnapshot delivers the next snapshot answer in Pacing's pieces,
 * outlasting the lease; a stalledSnapshot delivers one piece of it and then
 * nothing more. */
export type Fault = "dropAck" | "duplicate" | "lostPull" | "snapshot5xx"
  | "slowSnapshot" | "stalledSnapshot";

/** Deliberately wrong transports, for checking that the oracle notices. Each
 * acts once, on the first request it matches. starveProgress paces the first
 * snapshot answer whose caller asks for progress as a slowSnapshot, but never
 * reports a piece. */
export type Broken = "dropBatch" | "reidBatch" | "holdBatch" | "skipWindow"
  | "starveProgress";

/** How a slow or stalled answer arrives: a piece every `pieceMs`, `pieces`
 * of them for a slow one. */
export interface Pacing {
  pieceMs: number;
  pieces: number;
}

export type FetchJson = (
  path: string, init?: RequestInit, opts?: ApiFetchOptions,
) => Promise<unknown>;

/** The two doors as one page load sees them. */
export interface TransportLife {
  fetchJson: FetchJson;
  post(body: OpBatch): Promise<OpsAck>;
}

export interface Transport extends TransportLife {
  setOffline(offline: boolean): void;
  arm(fault: Fault): void;
  clearFaults(): void;
  /** Request bodies of every POST /api/ops the server answered 2xx, first
   * time only, keyed by batch id. Recorded on arrival, so a reply then
   * dropped, or discarded because its life ended, is still here. */
  readonly committed: ReadonlyMap<BatchId, string>;
  /** How many times a POST /api/ops for this batch id actually went out on
   * the network (whatever became of the answer). */
  sends(batchId: BatchId): number;
  /** How many armed faults of this kind have fired: met a request and done
   * their damage (sent twice, or sent with the reply dropped). */
  fired(fault: Fault): number;
  /** How many paced answers were abandoned with StalledReadError. */
  stalls(): number;
  /** Whether a paced answer is being delivered now. */
  pacing(): boolean;
  /** What a hung step waits on: each request on the wire now, as "METHOD
   * path", and each held by a stall, as "held METHOD path". */
  waiting(): string[];
  /** Test-only: every request whose path starts with `pathPrefix` ("" for
   * all) waits, before it is sent, until the returned release is called. A
   * stall is not a fault: clearFaults leaves it in place. Never released, it
   * is a network that never answers. */
  stall(pathPrefix: string): () => void;
  /** Ends the current life and returns doors bound to a new one. A request
   * from an ended life is not sent, and a reply arriving for one is
   * discarded: its caller sees a network error, as a reloaded page's
   * in-flight fetches do, though the server may already have committed. */
  newLife(): TransportLife;
}

const networkError = (): TypeError => new TypeError("fetch failed");

type RequestKind = "ops" | "pull" | "other";

/** Matched on the path alone: a pull's query string names its pending
 * batches, so `/api/sync/snapshot?pending=...` is still a pull. */
function kindOf(path: string, method: string): RequestKind {
  const route = path.split("?")[0];
  if (method === "POST" && route === "/api/ops") return "ops";
  if (method === "GET" && (route === "/api/sync/changes" ||
                           route === "/api/sync/snapshot")) return "pull";
  return "other";
}

const isSnapshot = (path: string): boolean => path.split("?")[0] === "/api/sync/snapshot";

function faultMatches(fault: Fault, kind: RequestKind, path: string): boolean {
  if (fault === "snapshot5xx" || fault === "slowSnapshot" ||
      fault === "stalledSnapshot") return isSnapshot(path);
  return fault === "lostPull" ? kind === "pull" : kind === "ops";
}

/** The parts of FastAPI's error body apiFetch keeps: a string detail. */
function detailOf(body: unknown): string | undefined {
  if (body && typeof body === "object" &&
      typeof (body as { detail?: unknown }).detail === "string") {
    return (body as { detail: string }).detail;
  }
  return undefined;
}

interface Answer {
  status: number;
  body: unknown;
}

export interface TransportOptions {
  /** Appended as `limit` to every GET /api/sync/changes, so a catch-up
   * crosses window boundaries; absent, the server's default applies. */
  windowLimit?: number;
  /** Aborts every request the transport has on the wire: the aborted fetch
   * surfaces as the network error a dead life gives, so the app sees an
   * ordinary failed request. */
  signal?: AbortSignal;
  /** Needed only by the paced faults and starveProgress. */
  pacing?: Pacing;
}

/** `path` with `limit=` appended when it is a changes-feed request. */
export function withWindowLimit(path: string, windowLimit?: number): string {
  if (windowLimit === undefined || path.split("?")[0] !== "/api/sync/changes") {
    return path;
  }
  return `${path}${path.includes("?") ? "&" : "?"}limit=${windowLimit}`;
}

export function createTransport(server: ServerControl, broken?: Broken,
                                { windowLimit, signal, pacing }: TransportOptions = {}): Transport {
  let offline = false;
  let faults: Fault[] = [];
  const firedCounts: Record<Fault, number> = {
    dropAck: 0, duplicate: 0, lostPull: 0, snapshot5xx: 0, slowSnapshot: 0, stalledSnapshot: 0,
  };
  let stalled = 0;
  let paced = 0;
  let starved = false;
  let generation = 0;
  let brokenUsed = false;
  let lastSeq = seqOf(0);
  let held: string | null = null;
  let stalls: { prefix: string; released: Promise<void> }[] = [];
  const committed = new Map<BatchId, string>();
  const sent = new Map<BatchId, number>();
  const waitingOn = new Set<{ label: string }>();

  const noteSeq = (value: unknown): void => {
    if (typeof value === "number" && value > lastSeq) lastSeq = seqOf(value);
  };

  /** One HTTP exchange, recorded before anyone can drop its reply. Every
   * send checks its life first, so a second send for one request (a
   * duplicate fault, a broken mode) never goes out once the life has ended. */
  const sendOne = async (path: string, init: RequestInit,
                         live: () => boolean): Promise<Answer> => {
    if (!live()) throw networkError();
    const headers = new Headers(init.headers);
    headers.set("cookie", server.cookie);
    const isOps = kindOf(path, init.method ?? "GET") === "ops";
    if (isOps) {
      const { batchId } = readBatchHead(String(init.body));
      sent.set(batchId, (sent.get(batchId) ?? 0) + 1);
    }
    let res: Response;
    let text: string;
    const wait = { label: `${init.method ?? "GET"} ${path}` };
    waitingOn.add(wait);
    try {
      res = await fetch(`${BASE_URL}${path}`, { ...init, headers, signal });
      text = await res.text();
    } catch (error) {
      // An abort rejects with a DOMException; the app sees a dead network.
      if (signal?.aborted) throw networkError();
      throw error;
    } finally {
      waitingOn.delete(wait);
    }
    let body: unknown = null;
    try {
      body = text === "" ? null : JSON.parse(text);
    } catch {
      body = text;
    }
    if (res.ok && isOps) {
      const { batchId } = readBatchHead(String(init.body));
      if (!committed.has(batchId)) committed.set(batchId, String(init.body));
    }
    if (res.ok && body && typeof body === "object" && !Array.isArray(body)) {
      const b = record(body, "answer");
      noteSeq(b.seq);
      noteSeq(b.latest_seq);
    }
    return { status: res.status, body };
  };

  const fakeAck = (requestBody: string): Answer => ({
    status: 200,
    body: {
      ok: true, ts: 0,
      applied: readBatchHead(requestBody).opCount,
      seq: lastSeq, skipped: [],
    } satisfies OpsAck,
  });

  /** The broken mode's version of an exchange, or plain `send`. */
  const exchange = async (
    path: string, init: RequestInit, kind: RequestKind, live: () => boolean,
  ): Promise<Answer> => {
    const send = (p: string, i: RequestInit): Promise<Answer> => sendOne(p, i, live);
    if (broken === undefined || (brokenUsed && held === null)) {
      return send(path, init);
    }
    const body = String(init.body);
    if (kind === "ops") {
      if (broken === "dropBatch" && !brokenUsed) {
        brokenUsed = true;
        return fakeAck(body);
      }
      if (broken === "reidBatch" && !brokenUsed) {
        brokenUsed = true;
        const answer = await send(path, init);
        const batch = record(JSON.parse(body), "ops body");
        await send(path, {
          ...init,
          body: JSON.stringify({ ...batch, batch_id: `${readBatchHead(body).batchId}-re` }),
        });
        return answer;
      }
      if (broken === "holdBatch") {
        if (!brokenUsed) {
          brokenUsed = true;
          held = body;
          return fakeAck(body);
        }
        if (held !== null) {
          const late = held;
          held = null;
          const answer = await send(path, init);
          await send(path, { ...init, body: late });
          return answer;
        }
      }
    }
    if (broken === "skipWindow" && !brokenUsed &&
        path.startsWith("/api/sync/changes")) {
      const answer = await send(path, init);
      const feed = answer.status === 200 ? parseChanges(answer.body) : null;
      if (feed !== null && feed.blocks.length > 0) {
        brokenUsed = true;
        return { ...answer, body: { ...feed, blocks: [] } };
      }
      return answer;
    }
    return send(path, init);
  };

  /** Waits `ms`, or throws as the request in delivery would end: the
   * caller aborts it (as fetch rejects), or its life, the network or the
   * example ends (a network error). */
  const pause = async (ms: number, live: () => boolean,
                       caller: AbortSignal | null | undefined): Promise<void> => {
    await new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        caller?.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      caller?.addEventListener("abort", done);
    });
    if (caller?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
    if (offline || !live() || signal?.aborted) throw networkError();
  };

  /** Delivers an answer the server already gave in pieces, `onPiece` after
   * each. Stalled, it delivers one piece and then nothing, until `stallMs`
   * of silence rejects it, or for ever without one. */
  const deliverPaced = async (
    how: "slow" | "stalled", live: () => boolean, init: RequestInit | undefined,
    opts: ApiFetchOptions | undefined, onPiece: () => void,
  ): Promise<void> => {
    if (pacing === undefined) throw new Error(`a ${how} answer needs the transport's pacing`);
    paced += 1;
    try {
      const pieces = how === "slow" ? pacing.pieces : 1;
      for (let i = 0; i < pieces; i += 1) {
        await pause(pacing.pieceMs, live, init?.signal);
        onPiece();
      }
      if (how === "slow") return;
      for (let silent = 0; ; silent += pacing.pieceMs) {
        if (opts?.stallMs !== undefined && silent >= opts.stallMs) {
          stalled += 1;
          throw new StalledReadError(opts.stallMs);
        }
        await pause(pacing.pieceMs, live, init?.signal);
      }
    } finally {
      paced -= 1;
    }
  };

  /** A request on behalf of life `life` (null: the transport's own doors,
   * which no life change ends). */
  const request = async (
    life: number | null, path: string, init?: RequestInit, opts?: ApiFetchOptions,
  ): Promise<unknown> => {
    const live = (): boolean => life === null || life === generation;
    if (offline || !live()) throw networkError();
    const holding = stalls.filter((st) => path.startsWith(st.prefix));
    if (holding.length > 0) {
      const wait = { label: `held ${(init?.method ?? "GET").toUpperCase()} ${path}` };
      waitingOn.add(wait);
      try {
        await Promise.all(holding.map((st) => st.released));
      } finally {
        waitingOn.delete(wait);
      }
      if (offline || !live()) throw networkError();
    }
    const method = (init?.method ?? "GET").toUpperCase();
    const kind = kindOf(path, method);
    const at = faults.findIndex((f) => faultMatches(f, kind, path));
    const fault = at < 0 ? null : faults[at];
    if (at >= 0) faults = faults.filter((_, i) => i !== at);
    if (fault === "snapshot5xx") {
      firedCounts.snapshot5xx += 1;
      throw new ApiError(503, path, "proptest: injected snapshot failure");
    }
    const fullInit: RequestInit = { ...init, method };
    const sentPath = method === "GET" ? withWindowLimit(path, windowLimit) : path;
    let answer = await exchange(sentPath, fullInit, kind, live);
    if (fault === "duplicate") answer = await exchange(sentPath, fullInit, kind, live);
    if (fault !== null) firedCounts[fault] += 1;
    if (fault === "dropAck" || fault === "lostPull" || !live()) {
      throw networkError();
    }
    const progress = opts?.onProgress ?? ((): void => undefined);
    if (fault === "slowSnapshot" || fault === "stalledSnapshot") {
      await deliverPaced(fault === "slowSnapshot" ? "slow" : "stalled", live, init, opts,
                         progress);
    } else if (broken === "starveProgress" && !starved && isSnapshot(path) &&
               opts?.onProgress !== undefined) {
      starved = true;
      await deliverPaced("slow", live, init, opts, () => undefined);
    } else {
      progress();
    }
    if (answer.status < 200 || answer.status >= 300) {
      throw new ApiError(answer.status, path, detailOf(answer.body));
    }
    return answer.body;
  };

  const doors = (life: number | null): TransportLife => ({
    fetchJson: (path, init, opts) => request(life, path, init, opts),
    post: async (body) => parseOpsAck(await request(life, "/api/ops", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })),
  });

  return {
    ...doors(null),
    setOffline: (next) => { offline = next; },
    arm: (fault) => { faults = [...faults, fault]; },
    clearFaults: () => { faults = []; },
    stall: (prefix) => {
      let release = (): void => undefined;
      const stall = {
        prefix,
        released: new Promise<void>((resolve) => { release = resolve; }),
      };
      stalls = [...stalls, stall];
      return () => {
        stalls = stalls.filter((st) => st !== stall);
        release();
      };
    },
    committed,
    sends: (batchId) => sent.get(batchId) ?? 0,
    fired: (fault) => firedCounts[fault],
    stalls: () => stalled,
    pacing: () => paced > 0,
    waiting: () => [...waitingOn].map((w) => w.label),
    newLife: () => {
      generation += 1;
      return doors(generation);
    },
  };
}
