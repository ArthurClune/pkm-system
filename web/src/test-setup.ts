import "@testing-library/jest-dom/vitest";
import { afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import { FakeWebSocket } from "./test-helpers";

afterEach(cleanup);

vi.stubGlobal("WebSocket", FakeWebSocket);
afterEach(() => { FakeWebSocket.instances = []; });

// jsdom has no DragEvent (github.com/jsdom/jsdom#2913): without it,
// @testing-library/dom's fireEvent.dragOver/dragStart/drop fall back to a
// plain Event, silently dropping clientX/clientY from the init dict. Drop-
// zone math needs those, so polyfill the minimum: MouseEvent's coordinate
// getters plus a settable `dataTransfer` (RTL patches dataTransfer itself
// when window.DataTransfer is absent, so we don't need to model it here).
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
