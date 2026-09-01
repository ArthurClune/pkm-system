import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeWebSocket } from "../test-helpers";
import { RECONNECT_BASE_MS, RECONNECT_MAX_MS } from "./reconnectBackoff";
import { connectSocket, type SocketHandle } from "./socket";

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

  it("resets the backoff once a connection opens", () => {
    connect();
    for (const ms of [RECONNECT_BASE_MS, 4000, 8000]) expectNextAttemptAfter(ms);
    latest().open();
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
    latest().drop();
    window.dispatchEvent(new Event("online"));
    expect(created()).toBe(2);
    // the superseded backoff timer must not open a second socket
    vi.advanceTimersByTime(10 * 60_000);
    expect(created()).toBe(2);
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
});
