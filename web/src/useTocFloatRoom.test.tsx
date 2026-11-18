// jsdom has no layout: the pane's clientWidth is a variable the test
// sets, and its padding comes from the inline style, which jsdom's
// getComputedStyle does report.
import { act, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { useTocFloatRoom } from "./useTocFloatRoom";

let width = 0;
let renders = 0;

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

beforeEach(() => {
  renders = 0;
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => width);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  FakeResizeObserver.live = [];
});

function Harness({ sidebarOpen }: { sidebarOpen: boolean }) {
  const pane = useRef<HTMLElement>(null);
  const room = useTocFloatRoom(pane, sidebarOpen);
  renders += 1;
  return <main ref={pane} style={{ paddingLeft: "50px", paddingRight: "50px" }}
               data-room={String(room)} />;
}

const room = (container: HTMLElement) =>
  container.querySelector("main")!.getAttribute("data-room");

test("a wide pane with the sidebar closed has room", () => {
  width = 1000; // content 900
  const { container } = render(<Harness sidebarOpen={false} />);
  expect(room(container)).toBe("true");
});

test("opening the sidebar takes the room away, closing gives it back", () => {
  width = 1000;
  const { container, rerender } = render(<Harness sidebarOpen={false} />);
  rerender(<Harness sidebarOpen={true} />);
  expect(room(container)).toBe("false");
  rerender(<Harness sidebarOpen={false} />);
  expect(room(container)).toBe("true");
});

test("measures the content box, not the padded width", () => {
  width = 900; // content 800: the padding is not reading room
  const { container } = render(<Harness sidebarOpen={false} />);
  expect(room(container)).toBe("false");
});

test("a resize below the threshold takes the room away", () => {
  width = 1000;
  const { container } = render(<Harness sidebarOpen={false} />);
  width = 900;
  act(() => FakeResizeObserver.resize());
  expect(room(container)).toBe("false");
});

test("resizes that keep the answer cause no render", () => {
  width = 1000;
  render(<Harness sidebarOpen={false} />);
  const settled = renders;
  for (const w of [1100, 1200, 961]) {
    width = w;
    act(() => FakeResizeObserver.resize());
  }
  expect(renders).toBe(settled);
});
