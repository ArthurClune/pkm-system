import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FLASH_MS, useScrollFlashTarget } from "./useScrollFlashTarget";

// jsdom implements neither scrollIntoView nor layout; a spy is enough to
// pin that the block is centred rather than scrolled to its top edge.
let scrolled: ScrollIntoViewOptions | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  scrolled = undefined;
  Element.prototype.scrollIntoView = function (arg?: unknown) {
    scrolled = arg as ScrollIntoViewOptions;
  };
});

afterEach(() => {
  vi.useRealTimers();
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
  renderHook(() => useScrollFlashTarget("abc123", true));
  expect(scrolled).toEqual({ block: "center" });
  expect(el.classList.contains("flash-target")).toBe(true);
});

it("clears the flash once the animation window has passed", () => {
  const el = block("abc123");
  renderHook(() => useScrollFlashTarget("abc123", true));
  vi.advanceTimersByTime(FLASH_MS - 1);
  expect(el.classList.contains("flash-target")).toBe(true);
  vi.advanceTimersByTime(1);
  expect(el.classList.contains("flash-target")).toBe(false);
});

it("cancels the pending clear on unmount instead of firing it later", () => {
  const el = block("abc123");
  const { unmount } = renderHook(() => useScrollFlashTarget("abc123", true));
  unmount();
  vi.advanceTimersByTime(FLASH_MS * 2);
  // The timer was cleared, so nothing touched the (now detached) element.
  expect(el.classList.contains("flash-target")).toBe(true);
});

it("does nothing until the readiness token is truthy", () => {
  const el = block("abc123");
  const { rerender } = renderHook(
    ({ ready }: { ready: unknown }) => useScrollFlashTarget("abc123", ready),
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
    ({ ready }: { ready: unknown }) => useScrollFlashTarget("abc123", ready),
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

  renderHook(() => useScrollFlashTarget("not-on-this-page", true));
  expect(scrolled).toBeUndefined();
});

it("escapes the uid rather than injecting it into the selector", () => {
  const el = block('a"b');
  renderHook(() => useScrollFlashTarget('a"b', true));
  expect(el.classList.contains("flash-target")).toBe(true);
});

it("searches only inside the given root, never the whole document", () => {
  const outside = block("shared-uid"); // e.g. the same page open in the main pane
  const panel = document.createElement("div");
  document.body.appendChild(panel);
  const inside = block("shared-uid", panel);

  const root = { current: panel };
  renderHook(() => useScrollFlashTarget("shared-uid", true, root));

  expect(inside.classList.contains("flash-target")).toBe(true);
  expect(outside.classList.contains("flash-target")).toBe(false);
});

it("does nothing when a root was given but has not mounted yet", () => {
  const el = block("abc123");
  const root: { current: HTMLElement | null } = { current: null };
  renderHook(() => useScrollFlashTarget("abc123", true, root));
  expect(el.classList.contains("flash-target")).toBe(false);
  expect(scrolled).toBeUndefined();
});
