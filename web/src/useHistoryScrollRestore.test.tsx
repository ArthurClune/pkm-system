import { act, render } from "@testing-library/react";
import { useRef } from "react";
import { BrowserRouter, useNavigate, type NavigateFunction } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  RESTORE_GIVE_UP_MS, resetHistoryScroll, useHistoryScrollRestore, useRestoresHistoryScroll,
} from "./useHistoryScrollRestore";
import { PIN_QUIET_MS } from "./useScrollFlashTarget";

// jsdom has no layout: the window's offset is a variable that scrollTo
// clamps to `maxY`, which stands for how tall the document currently is.
let y = 0;
let maxY = 10_000;
let navigate: NavigateFunction;
let restores: boolean;

class FakeResizeObserver {
  static live: FakeResizeObserver[] = [];
  constructor(private cb: ResizeObserverCallback) { FakeResizeObserver.live.push(this); }
  observe() {}
  unobserve() {}
  disconnect() { FakeResizeObserver.live = FakeResizeObserver.live.filter((o) => o !== this); }
  static resize() {
    for (const o of [...FakeResizeObserver.live]) o.cb([], o as unknown as ResizeObserver);
  }
}

function Harness() {
  const main = useRef<HTMLElement>(null);
  useHistoryScrollRestore(main);
  restores = useRestoresHistoryScroll();
  navigate = useNavigate();
  return <main ref={main} />;
}

const mount = () => render(<BrowserRouter><Harness /></BrowserRouter>);

function userScroll(to: number) {
  y = to;
  window.dispatchEvent(new Event("scroll"));
}

/** Back or forward to an entry: jsdom traverses on a timer of its own. */
function popTo(state: unknown, path: string) {
  act(() => {
    window.history.replaceState(state, "", path);
    window.dispatchEvent(new PopStateEvent("popstate", { state }));
  });
}

function grow() {
  maxY = 10_000;
  act(() => FakeResizeObserver.resize());
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  FakeResizeObserver.live = [];
  y = 0;
  maxY = 10_000;
  Object.defineProperty(window, "scrollY", { configurable: true, get: () => y });
  vi.spyOn(window, "scrollTo").mockImplementation(
    ((_x: number, top: number) => { y = Math.min(top, maxY); }) as typeof window.scrollTo);
  sessionStorage.clear();
  resetHistoryScroll();
  window.history.replaceState(null, "", "/a");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("gives the first entry a key of its own and takes over restoration", () => {
  const before = window.history.scrollRestoration;
  const { unmount } = mount();
  const state = window.history.state as { key?: unknown };
  expect(typeof state.key).toBe("string");
  expect(state.key).not.toBe("default");
  expect(window.history.scrollRestoration).toBe("manual");
  unmount();
  expect(window.history.scrollRestoration).toBe(before);
});

it("back restores the offset once the page has grown tall enough", () => {
  mount();
  const a = window.history.state as unknown;
  userScroll(500);
  act(() => { void navigate("/b"); });
  expect(window.scrollTo).not.toHaveBeenCalled();
  expect(restores).toBe(false);

  maxY = 0; // the incoming entry shows "Loading…"
  popTo(a, "/a");
  expect(restores).toBe(true);
  expect(y).toBe(0);
  window.dispatchEvent(new Event("scroll")); // that clamp, recorded nowhere
  grow();
  expect(y).toBe(500);
});

it("records the outgoing offset at popstate, before its scroll event", () => {
  mount();
  const a = window.history.state as unknown;
  act(() => { void navigate("/b"); });
  const b = window.history.state as unknown;
  y = 800; // scrolled in the same frame as the back: no scroll event yet
  popTo(a, "/a");
  popTo(b, "/b");
  expect(y).toBe(800);
});

it("lets go when the reader scrolls, so a later resize leaves them be", () => {
  mount();
  const a = window.history.state as unknown;
  userScroll(500);
  act(() => { void navigate("/b"); });
  maxY = 0;
  popTo(a, "/a");
  window.dispatchEvent(new Event("wheel"));
  userScroll(0);
  grow();
  expect(y).toBe(0);
});

it("holds the offset until the layout has been quiet, then lets go", () => {
  mount();
  const a = window.history.state as unknown;
  userScroll(300);
  act(() => { void navigate("/b"); });
  popTo(a, "/a");
  expect(y).toBe(300);
  y = 50; // content above changed the offset; still pinned
  grow();
  expect(y).toBe(300);
  act(() => { vi.advanceTimersByTime(PIN_QUIET_MS); });
  y = 50;
  grow();
  expect(y).toBe(50);
});

it("gives up on an offset the page never grows tall enough to reach", () => {
  mount();
  const a = window.history.state as unknown;
  userScroll(900);
  act(() => { void navigate("/b"); });
  maxY = 0;
  popTo(a, "/a");
  act(() => { vi.advanceTimersByTime(RESTORE_GIVE_UP_MS); });
  maxY = 10_000;
  act(() => FakeResizeObserver.resize());
  expect(y).toBe(0);
});

it("restores across a reload from sessionStorage", () => {
  const { unmount } = mount();
  userScroll(250);
  window.dispatchEvent(new Event("pagehide"));
  unmount();
  resetHistoryScroll();
  y = 0;
  mount(); // a fresh document: history.state survives, the module does not
  expect(restores).toBe(true);
  expect(y).toBe(250);
});
