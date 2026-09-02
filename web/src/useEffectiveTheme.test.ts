import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { stubMatchMedia } from "./test-helpers";
import { useEffectiveTheme } from "./useEffectiveTheme";

afterEach(() => {
  document.documentElement.removeAttribute("data-theme");
  vi.unstubAllGlobals();
  vi.restoreAllMocks(); // undoes this file's MutationObserver.prototype spies
});

it("resolves an explicit data-theme attribute", () => {
  document.documentElement.setAttribute("data-theme", "dark");
  expect(renderHook(() => useEffectiveTheme()).result.current).toBe("dark");
  document.documentElement.setAttribute("data-theme", "light");
  expect(renderHook(() => useEffectiveTheme()).result.current).toBe("light");
});

it("falls back to the OS preference for system (or absent) data-theme", () => {
  const mql = stubMatchMedia(true);
  document.documentElement.setAttribute("data-theme", "system");
  expect(renderHook(() => useEffectiveTheme()).result.current).toBe("dark");
  mql.matches = false;
  document.documentElement.removeAttribute("data-theme");
  expect(renderHook(() => useEffectiveTheme()).result.current).toBe("light");
});

it("tracks a data-theme change made after mount", async () => {
  document.documentElement.setAttribute("data-theme", "light");
  const { result } = renderHook(() => useEffectiveTheme());
  expect(result.current).toBe("light");
  document.documentElement.setAttribute("data-theme", "dark");
  await waitFor(() => expect(result.current).toBe("dark"));
});

it("tracks an OS preference change while on system", async () => {
  const mql = stubMatchMedia(false);
  document.documentElement.setAttribute("data-theme", "system");
  const { result } = renderHook(() => useEffectiveTheme());
  expect(result.current).toBe("light");
  mql.simulateChange(true);
  await waitFor(() => expect(result.current).toBe("dark"));
});

it("shares one MutationObserver across every subscriber, propagates a flip to all, and tears it down only once the last unmounts", async () => {
  const mql = stubMatchMedia(false);
  document.documentElement.setAttribute("data-theme", "system");

  // Spy on the real MutationObserver's observe()/disconnect() rather than
  // replacing the global constructor: @testing-library's own waitFor()
  // installs unrelated MutationObservers (watching document.body for its
  // polling optimization), so a global stub would double-count those too.
  // Filtering to calls that target document.documentElement isolates ours.
  const realObserve = MutationObserver.prototype.observe;
  const realDisconnect = MutationObserver.prototype.disconnect;
  const ourInstances = new Set<MutationObserver>();
  let observeCallsOnDocEl = 0;
  let disconnectCallsOnOurs = 0;
  vi.spyOn(MutationObserver.prototype, "observe").mockImplementation(
    function (this: MutationObserver, target: Node, options?: MutationObserverInit) {
      if (target === document.documentElement) {
        observeCallsOnDocEl += 1;
        ourInstances.add(this);
      }
      return realObserve.call(this, target, options);
    },
  );
  vi.spyOn(MutationObserver.prototype, "disconnect").mockImplementation(
    function (this: MutationObserver) {
      if (ourInstances.has(this)) disconnectCallsOnOurs += 1;
      return realDisconnect.call(this);
    },
  );

  const a = renderHook(() => useEffectiveTheme());
  const b = renderHook(() => useEffectiveTheme());
  const c = renderHook(() => useEffectiveTheme());
  // Three subscribers, one underlying observer watching documentElement.
  expect(observeCallsOnDocEl).toBe(1);
  expect(a.result.current).toBe("light");
  expect(b.result.current).toBe("light");
  expect(c.result.current).toBe("light");

  // A data-theme mutation (the MutationObserver path) reaches all three.
  document.documentElement.setAttribute("data-theme", "dark");
  await waitFor(() => {
    expect(a.result.current).toBe("dark");
    expect(b.result.current).toBe("dark");
    expect(c.result.current).toBe("dark");
  });

  // An OS preference change (the matchMedia path) also reaches all three.
  document.documentElement.setAttribute("data-theme", "system");
  mql.simulateChange(true);
  await waitFor(() => {
    expect(a.result.current).toBe("dark");
    expect(b.result.current).toBe("dark");
    expect(c.result.current).toBe("dark");
  });

  // Still exactly one observe() call on documentElement throughout.
  expect(observeCallsOnDocEl).toBe(1);

  // Unmounting some, but not all, subscribers must not tear the observer
  // down early.
  a.unmount();
  b.unmount();
  expect(disconnectCallsOnOurs).toBe(0);
  c.unmount();
  expect(disconnectCallsOnOurs).toBe(1);

  // A fresh subscriber after full teardown installs its own new observer,
  // proving the lazy-install-on-first-subscriber path still works.
  const d = renderHook(() => useEffectiveTheme());
  expect(observeCallsOnDocEl).toBe(2);
  d.unmount();
  expect(disconnectCallsOnOurs).toBe(2);
});
