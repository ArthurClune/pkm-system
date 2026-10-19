import "@testing-library/jest-dom/vitest";
import { afterAll, afterEach, beforeEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import { FakeLocalStorage, FakeWebSocket, stubMatchMedia } from "./test-helpers";

// Console guard: any console.warn or console.error fails the test that is
// running, or the file when it lands after the last test (jsdom's "Not
// implemented: navigation" arrives that way, on a timer). The wrappers are
// plain functions installed once, so a test that silences an expected log
// with `vi.spyOn(console, "warn").mockImplementation(...)` never reaches
// them, and `vi.restoreAllMocks()` puts them back. Registered before
// `afterEach(cleanup)` because after-hooks run in reverse order: unmount-time
// logs are then charged to the test that unmounted.
const realSetTimeout = setTimeout;
let logged: string[] = [];
for (const method of ["warn", "error"] as const) {
  const original = console[method].bind(console);
  console[method] = (...args: unknown[]) => {
    const text = args.map((a) => (a instanceof Error ? a.message : String(a))).join(" ");
    logged.push(`console.${method}: ${text}`);
    original(...args);
  };
}
function failOnLogged(): void {
  if (logged.length === 0) return;
  const messages = logged;
  logged = [];
  throw new Error(
    `unexpected console output (fix the cause, or silence an expected log ` +
    `in the test with vi.spyOn(console, ...).mockImplementation and assert ` +
    `it):\n${messages.join("\n")}`);
}
afterEach(failOnLogged);
afterAll(async () => {
  await new Promise<void>((resolve) => { realSetTimeout(resolve, 0); });
  failOnLogged();
});

afterEach(cleanup);

vi.stubGlobal("WebSocket", FakeWebSocket);
afterEach(() => { FakeWebSocket.instances = []; });

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
