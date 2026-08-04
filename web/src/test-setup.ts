import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import { FakeLocalStorage, FakeWebSocket, stubMatchMedia } from "./test-helpers";

afterEach(cleanup);

vi.stubGlobal("WebSocket", FakeWebSocket);
afterEach(() => { FakeWebSocket.instances = []; });

// jsdom logs its own "Not implemented: <feature>" errors (navigation, form
// submission, canvas, ...) straight to console.error whenever a component
// leaves some browser default action unprevented that jsdom can't emulate.
// Because jsdom schedules some of these on a timer (navigation is one), they
// can print after the test that triggered them has already finished, landing
// on whichever test happens to be running next -- see pkm-apr7, where a real
// anchor's un-prevented click left a "Not implemented: navigation" warning
// attributed to an unrelated test. Rather than let that keep happening
// silently, fail whichever test is current when one appears; it may not
// always be the offending test, but it stops the noise from accumulating
// unnoticed. Tests that intentionally silence console.error (e.g. via
// `vi.spyOn(console, "error").mockImplementation(...)`) bypass this, which is
// fine -- they're asserting their own expected error output.
let strayJsdomWarning: string | null = null;
const originalConsoleError = console.error.bind(console);
console.error = (...args: unknown[]) => {
  if (strayJsdomWarning === null) {
    const text = args.map((a) => (a instanceof Error ? a.message : String(a))).join(" ");
    if (text.includes("Not implemented:")) strayJsdomWarning = text;
  }
  originalConsoleError(...args);
};
afterEach(() => {
  if (strayJsdomWarning === null) return;
  const message = strayJsdomWarning;
  strayJsdomWarning = null;
  throw new Error(`jsdom logged an unhandled "Not implemented" warning: ${message}`);
});

// Re-installed before every test (not just once) because some test files
// call vi.unstubAllGlobals() in their own afterEach (e.g. to reset an
// IntersectionObserver stub), which would otherwise also wipe these out.
beforeEach(() => {
  // jsdom has no matchMedia; default to "OS is light" so components using
  // useTheme render without crashing in tests that don't care about theming.
  stubMatchMedia(false);

  // Node 26's own global `localStorage` getter shadows jsdom's real Storage
  // implementation and returns undefined without a --localstorage-file flag;
  // stub a working in-memory one so localStorage-backed code is testable.
  vi.stubGlobal("localStorage", new FakeLocalStorage());

  // jsdom has no DragEvent (github.com/jsdom/jsdom#2913): without it,
  // @testing-library/dom's fireEvent.dragOver/dragStart/drop fall back to a
  // plain Event, silently dropping clientX/clientY from the init dict. Drop-
  // zone math needs those, so polyfill the minimum: MouseEvent's coordinate
  // getters plus a settable `dataTransfer` (RTL patches dataTransfer itself
  // when window.DataTransfer is absent, so we don't need to model it here).
  // Declared inside the window guard: node-environment test files (e.g.
  // grammar tests) load this setup too, and MouseEvent only exists in jsdom.
  if (typeof window !== "undefined" && typeof window.DragEvent === "undefined") {
    class FakeDragEvent extends MouseEvent {
      dataTransfer: DataTransfer | null;
      constructor(type: string, init: MouseEventInit & { dataTransfer?: DataTransfer | null } = {}) {
        super(type, init);
        this.dataTransfer = init.dataTransfer ?? null;
      }
    }
    vi.stubGlobal("DragEvent", FakeDragEvent);
  }
});
