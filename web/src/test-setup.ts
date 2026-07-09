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
});
