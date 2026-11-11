import { act, renderHook } from "@testing-library/react";
import { createElement, StrictMode, type ReactNode } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { clientIdOf, FakeWebSocket } from "../test-helpers";
import { createSyncSession, type SyncSession } from "./session";
import { useSocketLifecycle } from "./useSocketLifecycle";

function lastWs(): FakeWebSocket {
  return FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
}

/** A session with no replica, started: the hook only hands it the socket. */
function startedSession(): SyncSession {
  const session = createSyncSession({
    replica: null,
    clientId: clientIdOf("lifecycle-test"),
    fetchJson: async (path) => { throw new Error(`unexpected fetch ${path}`); },
    outlines: {
      track: () => undefined,
      attachReplay: () => undefined,
      repairSessions: async () => undefined,
    },
    report: {
      status: () => undefined, replicaState: () => undefined,
      problem: () => undefined, resync: () => undefined,
      pending: () => undefined, unsentInMemory: () => undefined,
    },
  });
  void session.startup();
  return session;
}

const strict = ({ children }: { children: ReactNode }) =>
  createElement(StrictMode, null, children);

afterEach(() => { vi.restoreAllMocks(); });

test("a socket status reaches the session", async () => {
  const session = startedSession();
  const onSocketStatus = vi.spyOn(session, "onSocketStatus");
  renderHook(() => useSocketLifecycle({
    session, mountedRef: { current: false }, disposeOwned: () => undefined,
  }));

  await act(async () => { lastWs().open(); });
  expect(onSocketStatus.mock.calls).toEqual([[true]]);
  expect(session.status()).toBe("connected");

  await act(async () => { lastWs().drop(); });
  expect(onSocketStatus.mock.calls).toEqual([[true], [false]]);
  expect(session.status()).toBe("reconnecting");
});

test("a real unmount disposes the session, then the owned replica, once",
async () => {
  const session = startedSession();
  const order: string[] = [];
  vi.spyOn(session, "dispose").mockImplementation(() => { order.push("session"); });
  const mountedRef = { current: false };
  const { unmount } = renderHook(() => useSocketLifecycle({
    session, mountedRef, disposeOwned: () => { order.push("owned"); },
  }));
  expect(mountedRef.current).toBe(true);

  unmount();
  expect(mountedRef.current).toBe(false);
  expect(order).toEqual([]);
  await act(async () => { await Promise.resolve(); });
  await act(async () => { await Promise.resolve(); });

  expect(order).toEqual(["session", "owned"]);
  expect(lastWs().closedByApp).toBe(true);
});

test("a StrictMode replay keeps the session", async () => {
  const session = startedSession();
  const dispose = vi.spyOn(session, "dispose");
  const disposeOwned = vi.fn();
  const mountedRef = { current: false };
  renderHook(() => useSocketLifecycle({ session, mountedRef, disposeOwned }),
             { wrapper: strict });
  // Past the microtask a deferred dispose would run in, and past the
  // closed first socket's onclose.
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });

  expect(dispose).not.toHaveBeenCalled();
  expect(disposeOwned).not.toHaveBeenCalled();
  expect(mountedRef.current).toBe(true);
  // The replayed setup's socket is the one that drives the session.
  await act(async () => { lastWs().open(); });
  expect(session.status()).toBe("connected");
});

test("a StrictMode replay's first socket closing late leaves the session connected",
async () => {
  const session = startedSession();
  renderHook(() => useSocketLifecycle({
    session, mountedRef: { current: false }, disposeOwned: () => undefined,
  }), { wrapper: strict });
  const [first, replayed] = FakeWebSocket.instances.slice(-2);
  expect(first.closedByApp).toBe(true);

  // Synchronous: an awaited act would let the first socket's close land.
  act(() => { replayed.open(); });
  expect(session.status()).toBe("connected");
  // The first socket's close event arrives only now.
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });

  expect(session.status()).toBe("connected");
});
