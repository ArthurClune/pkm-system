// pattern: Imperative Shell
// One simulated client's network: the queue's `post` and replicaSync's
// `fetchJson` both go through it, to the real proptest server, with the
// session cookie, one-shot faults and an optional deliberately broken mode.
//
// Errors mirror apiFetch (api/client.ts): a non-2xx answer throws ApiError,
// and a request that never got an answer throws the TypeError a failed
// fetch throws. apiFetch's read deadline is not reproduced: the server is
// local, and a hang would show as the property's own timeout.
import { ApiError, type ApiFetchOptions } from "../../api/client";
import type { BatchId, SyncSeq } from "../../api/brands";
import type { OpBatch, OpsAck } from "../../api/payloads";
import type { Changes } from "../../replica/apply";
import { BASE_URL } from "./env";
import type { ServerControl } from "./serverControl";

/** One-shot faults, each consumed by the next request of its kind. */
export type Fault = "dropAck" | "duplicate" | "lostPull";

/** Deliberately wrong transports, for checking that the oracle notices. Each
 * acts once, on the first request it matches. */
export type Broken = "dropBatch" | "reidBatch" | "holdBatch" | "skipWindow";

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
  /** Ends the current life and returns doors bound to a new one. A request
   * from an ended life is not sent, and a reply arriving for one is
   * discarded: its caller sees a network error, as a reloaded page's
   * in-flight fetches do, though the server may already have committed. */
  newLife(): TransportLife;
}

const networkError = (): TypeError => new TypeError("fetch failed");

type RequestKind = "ops" | "pull" | "other";

function kindOf(path: string, method: string): RequestKind {
  if (method === "POST" && path === "/api/ops") return "ops";
  if (method === "GET" && (path.startsWith("/api/sync/changes") ||
                           path === "/api/sync/snapshot")) return "pull";
  return "other";
}

function faultMatches(fault: Fault, kind: RequestKind): boolean {
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

export function createTransport(server: ServerControl, broken?: Broken): Transport {
  let offline = false;
  let faults: Fault[] = [];
  let generation = 0;
  let brokenUsed = false;
  let lastSeq = 0 as SyncSeq;
  let held: string | null = null;
  const committed = new Map<BatchId, string>();

  const noteSeq = (seq: unknown): void => {
    if (typeof seq === "number" && seq > lastSeq) lastSeq = seq as SyncSeq;
  };

  /** One HTTP exchange, recorded before anyone can drop its reply. */
  const send = async (path: string, init: RequestInit): Promise<Answer> => {
    const headers = new Headers(init.headers);
    headers.set("cookie", server.cookie);
    const res = await fetch(`${BASE_URL}${path}`, { ...init, headers });
    const text = await res.text();
    let body: unknown = null;
    try {
      body = text === "" ? null : JSON.parse(text);
    } catch {
      body = text;
    }
    if (res.ok && kindOf(path, init.method ?? "GET") === "ops") {
      const batchId = (JSON.parse(String(init.body)) as OpBatch).batch_id;
      if (!committed.has(batchId)) committed.set(batchId, String(init.body));
    }
    if (res.ok && body && typeof body === "object") {
      const b = body as { seq?: unknown; latest_seq?: unknown };
      noteSeq(b.seq);
      noteSeq(b.latest_seq);
    }
    return { status: res.status, body };
  };

  const fakeAck = (requestBody: string): Answer => ({
    status: 200,
    body: {
      ok: true, ts: 0,
      applied: (JSON.parse(requestBody) as OpBatch).ops.length,
      seq: lastSeq, skipped: [],
    } satisfies OpsAck,
  });

  /** The broken mode's version of an exchange, or plain `send`. */
  const exchange = async (
    path: string, init: RequestInit, kind: RequestKind,
  ): Promise<Answer> => {
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
        const batch = JSON.parse(body) as OpBatch;
        await send(path, {
          ...init,
          body: JSON.stringify({ ...batch, batch_id: `${batch.batch_id}-re` }),
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
      const feed = answer.body as Changes | null;
      if (answer.status === 200 && feed && feed.blocks.length > 0) {
        brokenUsed = true;
        return { ...answer, body: { ...feed, blocks: [] } };
      }
      return answer;
    }
    return send(path, init);
  };

  /** A request on behalf of life `life` (null: the transport's own doors,
   * which no life change ends). */
  const request = async (
    life: number | null, path: string, init?: RequestInit,
  ): Promise<unknown> => {
    const live = (): boolean => life === null || life === generation;
    if (offline || !live()) throw networkError();
    const method = (init?.method ?? "GET").toUpperCase();
    const kind = kindOf(path, method);
    const at = faults.findIndex((f) => faultMatches(f, kind));
    const fault = at < 0 ? null : faults[at];
    if (at >= 0) faults = faults.filter((_, i) => i !== at);
    const fullInit: RequestInit = { ...init, method };
    let answer = await exchange(path, fullInit, kind);
    if (fault === "duplicate") answer = await exchange(path, fullInit, kind);
    if (fault === "dropAck" || fault === "lostPull" || !live()) {
      throw networkError();
    }
    if (answer.status < 200 || answer.status >= 300) {
      throw new ApiError(answer.status, path, detailOf(answer.body));
    }
    return answer.body;
  };

  const doors = (life: number | null): TransportLife => ({
    fetchJson: (path, init) => request(life, path, init),
    post: async (body) => (await request(life, "/api/ops", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })) as OpsAck,
  });

  return {
    ...doors(null),
    setOffline: (next) => { offline = next; },
    arm: (fault) => { faults = [...faults, fault]; },
    clearFaults: () => { faults = []; },
    committed,
    newLife: () => {
      generation += 1;
      return doors(generation);
    },
  };
}
