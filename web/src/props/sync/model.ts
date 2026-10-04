// pattern: Functional Core
// The sync property's model: which clients are online and when an offline
// one comes back, which batch ids must land and which must be rejected, each
// client's unused create uids, and the server clock. The expected tree is the
// oracle's job, not the model's.
//
// The server clock is the harness's own (sync_server.py) and never ticks. It
// starts at START_MS, every reset returns it there, and it never moves
// before START_MS or more than a year past it: the harness's session cookie
// is issued at START_MS, and the server refuses one issued in its future or
// more than a year ago.
import type { BatchId } from "../../api/brands";

export interface SyncModel {
  clients: string[];
  online: Record<string, boolean>;
  /** Per client: the countdown an Offline with a drawn return started, or
   * null (online, or offline until quiesce). */
  backAfter: Record<string, Countdown | null>;
  /** Unused create uids per client, in the order they are taken. */
  freshUids: Record<string, string[]>;
  /** Pool uids some Edit has created (in an enqueued batch, not necessarily
   * delivered yet). */
  createdUids: string[];
  /** Client name -> the batch ids it enqueued that must land, in order. */
  good: Map<string, BatchId[]>;
  /** Batch ids the server must reject. */
  bad: Set<BatchId>;
  /** A write failure is armed, or the lane entry it caused is unsent: no
   * BadBatch, Reload or second writeFails until it clears. */
  armedWriteFails: Record<string, boolean>;
  clockMs: number;
}

const ZONE = "Europe/London";

const zoneParts = new Intl.DateTimeFormat("en-GB", {
  timeZone: ZONE, hourCycle: "h23",
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit",
});

interface LocalTime { y: number; m: number; d: number; hh: number; mm: number; ss: number }

/** The Europe/London wall-clock time at `ms`. */
export function londonTime(ms: number): LocalTime {
  const part = (type: string): number =>
    Number(zoneParts.formatToParts(ms).find((p) => p.type === type)?.value);
  return { y: part("year"), m: part("month"), d: part("day"),
           hh: part("hour"), mm: part("minute"), ss: part("second") };
}

/** Epoch ms of a Europe/London wall-clock time (one that exists and is not
 * ambiguous; every time the harness asks for is). */
export function londonMs(y: number, m: number, d: number,
                         hh = 0, mm = 0, ss = 0): number {
  const wall = Date.UTC(y, m - 1, d, hh, mm, ss);
  const offsetAt = (ms: number): number => {
    const t = londonTime(ms);
    return Date.UTC(t.y, t.m - 1, t.d, t.hh, t.mm, t.ss) - ms;
  };
  const guess = wall - offsetAt(wall);
  return wall - offsetAt(guess);
}

export const START_MS = londonMs(2026, 3, 1, 12, 0, 0);

/** The changeover dates CrossMidnight visits: GMT->BST and BST->GMT. */
export const SPRING_FORWARD = "2026-03-29";
export const FALL_BACK = "2026-10-25";

export type MidnightDay = "model" | typeof SPRING_FORWARD | typeof FALL_BACK;

/** Where CrossMidnight puts the clock: 23:59:55 local on the chosen day,
 * then ten seconds later. A changeover day already behind the clock falls
 * back to the model's own date, so the clock never runs backwards. */
export function midnightCrossing(clockMs: number, day: MidnightDay): {
  date: string; before: number; after: number; fellBack: boolean;
} {
  const today = londonTime(clockMs);
  const own = { y: today.y, m: today.m, d: today.d };
  let chosen = own;
  let fellBack = false;
  if (day !== "model") {
    const [y, m, d] = day.split("-").map(Number);
    if (londonMs(y, m, d, 23, 59, 55) >= clockMs) chosen = { y, m, d };
    else fellBack = true;
  }
  const before = londonMs(chosen.y, chosen.m, chosen.d, 23, 59, 55);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return {
    date: `${chosen.y}-${pad(chosen.m)}-${pad(chosen.d)}`,
    before, after: before + 10_000, fellBack,
  };
}

/** When an Offline's client comes back by itself: after this many more
 * commands have run, or not until quiesce brings every client online. */
export type OfflineBack = number | "quiesce";

export interface Countdown {
  /** The drawn number of commands, for the transcript. */
  after: number;
  /** Commands still to run, the one in hand included, before the return. */
  left: number;
}

/** A command is about to run: every countdown is one nearer. Returns the
 * countdowns left and the clients due back online once this command has
 * run, each with the count it was drawn with. An Offline that starts a
 * countdown does so after this, so it never counts itself. */
export function countDown(backAfter: Readonly<Record<string, Countdown | null>>): {
  backAfter: Record<string, Countdown | null>;
  due: { client: string; after: number }[];
} {
  const next: Record<string, Countdown | null> = {};
  const due: { client: string; after: number }[] = [];
  for (const [client, c] of Object.entries(backAfter)) {
    if (c === null || c.left <= 1) {
      next[client] = null;
      if (c !== null) due.push({ client, after: c.after });
    } else {
      next[client] = { after: c.after, left: c.left - 1 };
    }
  }
  return { backAfter: next, due };
}

export const FRESH_PER_CLIENT = 8;

/** A client's own create uids: `pt_<client>_<n>`, valid block uids. */
export function freshPool(client: string): string[] {
  return Array.from({ length: FRESH_PER_CLIENT }, (_, i) => `pt_${client}_${i + 1}`);
}

export function initialModel(clients: string[]): SyncModel {
  const each = <T>(f: (c: string) => T): Record<string, T> =>
    Object.fromEntries(clients.map((c) => [c, f(c)]));
  return {
    clients: [...clients],
    online: each(() => true),
    backAfter: each(() => null),
    freshUids: each(freshPool),
    createdUids: [],
    good: new Map(clients.map((c) => [c, []])),
    bad: new Set(),
    armedWriteFails: each(() => false),
    clockMs: START_MS,
  };
}
