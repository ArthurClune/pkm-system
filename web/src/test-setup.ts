import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import { FakeLocalStorage, FakeWebSocket, stubMatchMedia } from "./test-helpers";

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
