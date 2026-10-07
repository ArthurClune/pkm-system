import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FLASH_MS, PIN_QUIET_MS, useScrollFlashTarget } from "./useScrollFlashTarget";
import { uid } from "./test-helpers";

// jsdom implements neither scrollIntoView nor layout; a spy is enough to
// pin that the block is centred rather than scrolled to its top edge.
let scrolled: ScrollIntoViewOptions | undefined;
let scrolls = 0;

// jsdom has no ResizeObserver either; this one lets a test say "the layout
// under this element just changed".
class FakeResizeObserver {
  static live: FakeResizeObserver[] = [];
  targets: Element[] = [];
  constructor(private cb: ResizeObserverCallback) { FakeResizeObserver.live.push(this); }
  observe(t: Element) { this.targets.push(t); }
  unobserve() {}
  disconnect() {
    this.targets = [];
    FakeResizeObserver.live = FakeResizeObserver.live.filter((o) => o !== this);
  }
  static resize() {
    for (const o of [...FakeResizeObserver.live]) {
      if (o.targets.length > 0) o.cb([], o as unknown as ResizeObserver);
    }
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  FakeResizeObserver.live = [];
  scrolled = undefined;
  scrolls = 0;
  Element.prototype.scrollIntoView = function (arg?: unknown) {
    scrolled = arg as ScrollIntoViewOptions;
    scrolls += 1;
  };
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

function block(uid: string, parent: HTMLElement = document.body): HTMLElement {
  const el = document.createElement("div");
  el.setAttribute("data-uid", uid);
  parent.appendChild(el);
  return el;
}

it("scrolls the block into the centre and flashes it", () => {
  const el = block("abc123");
  renderHook(() => useScrollFlashTarget(uid("abc123"), true));
  expect(scrolled).toEqual({ block: "center" });
  expect(el.classList.contains("flash-target")).toBe(true);
});

it("clears the flash once the animation window has passed", () => {
  const el = block("abc123");
  renderHook(() => useScrollFlashTarget(uid("abc123"), true));
  vi.advanceTimersByTime(FLASH_MS - 1);
  expect(el.classList.contains("flash-target")).toBe(true);
  vi.advanceTimersByTime(1);
  expect(el.classList.contains("flash-target")).toBe(false);
});

it("cancels the pending clear on unmount instead of firing it later", () => {
  const el = block("abc123");
  const { unmount } = renderHook(() => useScrollFlashTarget(uid("abc123"), true));
  unmount();
  vi.advanceTimersByTime(FLASH_MS * 2);
  // The timer was cleared, so nothing touched the (now detached) element.
  expect(el.classList.contains("flash-target")).toBe(true);
});

it("does nothing until the readiness token is truthy", () => {
  const el = block("abc123");
  const { rerender } = renderHook(
    ({ ready }: { ready: unknown }) => useScrollFlashTarget(uid("abc123"), ready),
    { initialProps: { ready: null as unknown } });
  expect(el.classList.contains("flash-target")).toBe(false);
  expect(scrolled).toBeUndefined();

  rerender({ ready: { page: "loaded" } });
  expect(el.classList.contains("flash-target")).toBe(true);
});

it("re-flashes when the readiness token is replaced by a fresh one", () => {
  const el = block("abc123");
  const payload = { n: 1 };
  const { rerender } = renderHook(
    ({ ready }: { ready: unknown }) => useScrollFlashTarget(uid("abc123"), ready),
    { initialProps: { ready: payload as unknown } });
  vi.advanceTimersByTime(FLASH_MS);
  expect(el.classList.contains("flash-target")).toBe(false);

  rerender({ ready: { n: 2 } }); // e.g. a resync replacing the page payload
  expect(el.classList.contains("flash-target")).toBe(true);
});

it("does nothing without a uid, or when no block carries it", () => {
  block("abc123");
  renderHook(() => useScrollFlashTarget(null, true));
  expect(scrolled).toBeUndefined();

  renderHook(() => useScrollFlashTarget(uid("not-on-this-page"), true));
  expect(scrolled).toBeUndefined();
});

it("escapes the uid rather than injecting it into the selector", () => {
  const el = block('a"b');
  renderHook(() => useScrollFlashTarget(uid('a"b'), true));
  expect(el.classList.contains("flash-target")).toBe(true);
});

it("searches only inside the given root, never the whole document", () => {
  const outside = block("shared-uid"); // e.g. the same page open in the main pane
  const panel = document.createElement("div");
  document.body.appendChild(panel);
  const inside = block("shared-uid", panel);

  const root = { current: panel };
  renderHook(() => useScrollFlashTarget(uid("shared-uid"), true, { root }));

  expect(inside.classList.contains("flash-target")).toBe(true);
  expect(outside.classList.contains("flash-target")).toBe(false);
});

it("does nothing when a root was given but has not mounted yet", () => {
  const el = block("abc123");
  const root: { current: HTMLElement | null } = { current: null };
  renderHook(() => useScrollFlashTarget(uid("abc123"), true, { root }));
  expect(el.classList.contains("flash-target")).toBe(false);
  expect(scrolled).toBeUndefined();
});

it("scrolls again when the same uid is navigated to a second time", () => {
  // A toc entry clicked twice: the hash is unchanged, only the navigation is new.
  block("abc123");
  const { rerender } = renderHook(
    ({ navigation }: { navigation: string }) =>
      useScrollFlashTarget(uid("abc123"), true, { navigation }),
    { initialProps: { navigation: "k1" } });
  expect(scrolls).toBe(1);

  rerender({ navigation: "k1" });
  expect(scrolls).toBe(1);
  rerender({ navigation: "k2" });
  expect(scrolls).toBe(2);
});

it("re-centres the target when the page grows after the jump", () => {
  // Content above it (a PDF page replacing its slot, an embed resizing) would
  // otherwise push the target out of view.
  block("abc123");
  renderHook(() => useScrollFlashTarget(uid("abc123"), true));
  expect(scrolls).toBe(1);

  FakeResizeObserver.resize();
  expect(scrolls).toBe(2);
  expect(scrolled).toEqual({ block: "center" });
});

it.each(["wheel", "touchstart", "keydown", "pointerdown"])(
  "stops re-centring once the reader takes over (%s)", (type) => {
  block("abc123");
  renderHook(() => useScrollFlashTarget(uid("abc123"), true));
  window.dispatchEvent(new Event(type));
  FakeResizeObserver.resize();
  expect(scrolls).toBe(1);
});

it("stops re-centring once the layout has been quiet for a while", () => {
  block("abc123");
  renderHook(() => useScrollFlashTarget(uid("abc123"), true));
  vi.advanceTimersByTime(PIN_QUIET_MS - 1);
  FakeResizeObserver.resize(); // still settling: re-centres, and restarts the wait
  expect(scrolls).toBe(2);
  vi.advanceTimersByTime(PIN_QUIET_MS - 1);
  FakeResizeObserver.resize();
  expect(scrolls).toBe(3);
  vi.advanceTimersByTime(PIN_QUIET_MS);
  FakeResizeObserver.resize();
  expect(scrolls).toBe(3);
});

it("stops re-centring on unmount", () => {
  block("abc123");
  const { unmount } = renderHook(() => useScrollFlashTarget(uid("abc123"), true));
  unmount();
  FakeResizeObserver.resize();
  window.dispatchEvent(new Event("wheel"));
  expect(scrolls).toBe(1);
});

it("watches the target's ancestors up to the given root, and nothing outside it", () => {
  const panel = document.createElement("div");
  document.body.appendChild(panel);
  const children = document.createElement("div");
  panel.appendChild(children);
  block("abc123", children);
  renderHook(() => useScrollFlashTarget(uid("abc123"), true, { root: { current: panel } }));
  expect(FakeResizeObserver.live.flatMap((o) => o.targets)).toEqual([children, panel]);
});

it("watches up to the document element when no root is given", () => {
  block("abc123");
  renderHook(() => useScrollFlashTarget(uid("abc123"), true));
  expect(FakeResizeObserver.live.flatMap((o) => o.targets))
    .toEqual([document.body, document.documentElement]);
});
