import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeWebSocket } from "../test-helpers";
import { RECONNECT_BASE_MS, RECONNECT_MAX_MS } from "./reconnectBackoff";
import { connectSocket, RESUME_STALE_MS, STABLE_MS, type SocketHandle } from "./socket";

const created = (): number => FakeWebSocket.instances.length;
const latest = (): FakeWebSocket =>
  FakeWebSocket.instances[FakeWebSocket.instances.length - 1];

let handle: SocketHandle | null = null;
let statuses: boolean[] = [];
let hidden = false;

function connect(): SocketHandle {
  statuses = [];
  handle = connectSocket({
    onBatch: () => undefined,
    onStatus: (up) => statuses.push(up),
  });
  return handle;
}

/** Drop the live socket and assert the next connect attempt lands exactly
 * `ms` later -- not a tick sooner. */
function expectNextAttemptAfter(ms: number): void {
  const before = created();
  latest().drop();
  vi.advanceTimersByTime(ms - 1);
  expect(created()).toBe(before);
  vi.advanceTimersByTime(1);
  expect(created()).toBe(before + 1);
}

beforeEach(() => {
  vi.useFakeTimers();
  hidden = false;
  // jsdom's document.hidden is a prototype getter with no setter; an own
  // property shadows it for the test and is deleted again afterwards.
  Object.defineProperty(document, "hidden", {
    configurable: true, get: () => hidden,
  });
});

afterEach(() => {
  handle?.close();
  handle = null;
  delete (document as unknown as { hidden?: boolean }).hidden;
  vi.useRealTimers();
});

describe("connectSocket reconnect policy", () => {
  it("backs off exponentially from the base interval up to the ceiling", () => {
    connect();
    expect(created()).toBe(1);
    for (const ms of [RECONNECT_BASE_MS, 4000, 8000, 16000,
                      RECONNECT_MAX_MS, RECONNECT_MAX_MS]) {
      expectNextAttemptAfter(ms);
    }
  });

  it("keeps backing off when the server accepts then immediately closes (pkm-uue4)", () => {
    // A socket that opens and closes before it can prove itself (auth
    // expiry, load shedding, a middlebox completing the handshake then
    // dropping) must not reset the backoff -- otherwise an unhealthy server
    // gets hammered at the 2 s base forever.
    connect();
    for (const ms of [RECONNECT_BASE_MS, 4000, 8000, 16000, RECONNECT_MAX_MS]) {
      latest().open(); // accepted...
      expectNextAttemptAfter(ms); // ...but closed immediately, so the gap keeps growing
    }
  });

  it("resets the backoff once a connection stays open past STABLE_MS", () => {
    connect();
    for (const ms of [RECONNECT_BASE_MS, 4000, 8000]) expectNextAttemptAfter(ms);
    latest().open();
    vi.advanceTimersByTime(STABLE_MS);
    expectNextAttemptAfter(RECONNECT_BASE_MS);
  });

  it("resets the backoff as soon as the socket delivers its first frame", () => {
    connect();
    for (const ms of [RECONNECT_BASE_MS, 4000, 8000]) expectNextAttemptAfter(ms);
    const sock = latest();
    sock.open();
    sock.message({ client_id: "x", ts: 0, ops: [] }); // proof of life before STABLE_MS elapses
    expectNextAttemptAfter(RECONNECT_BASE_MS);
  });

  it("attempts nothing while the tab is hidden, and reconnects on return", () => {
    connect();
    hidden = true;
    latest().drop();
    vi.advanceTimersByTime(10 * 60_000);
    expect(created()).toBe(1);
    // the drop is still reported: the UI must show "reconnecting" either way
    expect(statuses).toEqual([false]);

    hidden = false;
    document.dispatchEvent(new Event("visibilitychange"));
    expect(created()).toBe(2);
  });

  it("cancels a pending reconnect when the tab is hidden mid-wait", () => {
    connect();
    latest().drop();
    vi.advanceTimersByTime(RECONNECT_BASE_MS - 1);
    hidden = true;
    document.dispatchEvent(new Event("visibilitychange"));

    vi.advanceTimersByTime(10 * 60_000);
    expect(created()).toBe(1);

    hidden = false;
    document.dispatchEvent(new Event("visibilitychange"));
    expect(created()).toBe(2);
  });

  it("reconnects immediately when the browser reports the network is back", () => {
    connect();
    // a socket that lived a while before dying: the schedule's delay has
    // already elapsed since the attempt, so 'online' is honoured at once
    vi.advanceTimersByTime(RECONNECT_BASE_MS);
    latest().drop();
    window.dispatchEvent(new Event("online"));
    expect(created()).toBe(2);
    // the superseded backoff timer must not open a second socket
    vi.advanceTimersByTime(10 * 60_000);
    expect(created()).toBe(2);
  });

  it("holds repeated 'online' events to the backoff schedule while hidden", () => {
    connect();
    hidden = true;
    latest().drop();
    // A flapping AP or a wifi/cellular handover fires 'online' over and over.
    // A hidden tab defers instead of scheduling, so without a rate limit every
    // event gets its own zero-delay attempt with the backoff counter pinned.
    const start = Date.now();
    const attemptsAt: number[] = [];
    let seen = created();
    for (let i = 0; i < 60; i += 1) {
      vi.advanceTimersByTime(1000);
      window.dispatchEvent(new Event("online"));
      if (created() > seen) {
        seen = created();
        attemptsAt.push(Date.now() - start);
        latest().drop();
      }
    }
    // the cumulative backoff schedule: 2s, +4s, +8s, +16s, +30s
    expect(attemptsAt).toEqual([2000, 6000, 14000, 30000, 60000]);
  });

  it("ignores 'online' while connected or while an attempt is in flight", () => {
    connect();
    window.dispatchEvent(new Event("online")); // first connect still in flight
    expect(created()).toBe(1);

    latest().open();
    window.dispatchEvent(new Event("online"));
    expect(created()).toBe(1);
    expect(statuses).toEqual([true]);
  });

  it("stops listening once closed", () => {
    connect();
    latest().drop();
    handle?.close();

    window.dispatchEvent(new Event("online"));
    document.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(10 * 60_000);
    expect(created()).toBe(1);
  });

  describe("frozen-socket resume heuristic (pkm-uue4)", () => {
    it("closes a nominally-open socket that has been hidden for RESUME_STALE_MS", () => {
      connect();
      const sock = latest();
      sock.open();

      hidden = true;
      document.dispatchEvent(new Event("visibilitychange"));
      vi.advanceTimersByTime(RESUME_STALE_MS);
      hidden = false;
      document.dispatchEvent(new Event("visibilitychange"));

      expect(sock.closedByApp).toBe(true);
    });

    it("leaves an open socket alone if hidden for less than RESUME_STALE_MS", () => {
      connect();
      const sock = latest();
      sock.open();

      hidden = true;
      document.dispatchEvent(new Event("visibilitychange"));
      vi.advanceTimersByTime(RESUME_STALE_MS - 1);
      hidden = false;
      document.dispatchEvent(new Event("visibilitychange"));

      expect(sock.closedByApp).toBe(false);
    });

    it("leaves a socket alone on resume if it never reached OPEN", () => {
      connect();
      const sock = latest(); // never opened: readyState stays CONNECTING

      hidden = true;
      document.dispatchEvent(new Event("visibilitychange"));
      vi.advanceTimersByTime(RESUME_STALE_MS);
      hidden = false;
      document.dispatchEvent(new Event("visibilitychange"));

      expect(sock.closedByApp).toBe(false);
    });
  });
});
