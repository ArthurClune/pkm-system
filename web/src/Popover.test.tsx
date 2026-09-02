import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Popover } from "./Popover";

afterEach(() => { vi.restoreAllMocks(); });

// jsdom reports zero-size rects, so give the popover a real footprint; the
// jsdom viewport is 1024x768. Returns a setter so a test can grow the
// content between renders, which is what `remeasure` exists to notice.
function mockPopoverRect(width: number, height: number) {
  const size = { width, height };
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
    () => ({
      width: size.width, height: size.height, x: 0, y: 0, top: 0, left: 0,
      right: size.width, bottom: size.height, toJSON: () => ({}),
    } as DOMRect));
  return (w: number, h: number) => { size.width = w; size.height = h; };
}

it("renders the popover chrome: a labelled dialog on the shared class", () => {
  mockPopoverRect(300, 150);
  render(<Popover label="References" x={40} y={60} onClose={vi.fn()}
                  remeasure={[]}>body</Popover>);
  const popover = screen.getByRole("dialog", { name: "References" });
  expect(popover).toHaveClass("block-ref-popover");
  expect(popover).toHaveTextContent("body");
});

// pkm-muka: the clamp above is in viewport coordinates, which only holds
// while `position: fixed` resolves against the viewport. A layout-contained
// ancestor (`.journal-day`'s `content-visibility: auto`) would become the
// containing block instead and displace the popover by that ancestor's
// scroll offset, so the shell renders at `document.body`, never in place.
it("renders in a portal at document.body (pkm-muka)", () => {
  mockPopoverRect(300, 150);
  const view = render(<Popover label="References" x={40} y={60} onClose={vi.fn()}
                               remeasure={[]}>body</Popover>);
  expect(view.container.querySelector(".block-ref-popover")).toBeNull();
  expect(screen.getByRole("dialog", { name: "References" }).parentElement)
    .toBe(document.body);
});

it("keeps an in-viewport anchor position unchanged", () => {
  mockPopoverRect(300, 150);
  render(<Popover label="References" x={40} y={60} onClose={vi.fn()}
                  remeasure={[]}>body</Popover>);
  const popover = screen.getByRole("dialog", { name: "References" });
  expect(popover.style.left).toBe("40px");
  expect(popover.style.top).toBe("60px");
});

it("clamps a measured popover anchored past the right/bottom edges", () => {
  mockPopoverRect(480, 300);
  render(<Popover label="References" x={2000} y={1500} onClose={vi.fn()}
                  remeasure={[]}>body</Popover>);
  const popover = screen.getByRole("dialog", { name: "References" });
  expect(popover.style.left).toBe(`${1024 - 480 - 12}px`);
  expect(popover.style.top).toBe(`${768 - 300 - 12}px`);
});

it("re-clamps when a value changes, and only then", () => {
  const resize = mockPopoverRect(200, 100);
  const view = render(
    <Popover label="References" x={2000} y={1500} onClose={vi.fn()}
             remeasure={["loading"]}>loading…</Popover>);
  const popover = screen.getByRole("dialog", { name: "References" });
  expect(popover.style.left).toBe(`${1024 - 200 - 12}px`);

  // content swap the caller declared: taller/wider rows replace the spinner
  resize(480, 300);
  view.rerender(
    <Popover label="References" x={2000} y={1500} onClose={vi.fn()}
             remeasure={["rows"]}>rows</Popover>);
  expect(popover.style.left).toBe(`${1024 - 480 - 12}px`);
  expect(popover.style.top).toBe(`${768 - 300 - 12}px`);

  // a re-render the caller did NOT declare must not re-measure: the position
  // is the caller's contract, not a resize observer's
  resize(100, 50);
  view.rerender(
    <Popover label="References" x={2000} y={1500} onClose={vi.fn()}
             remeasure={["rows"]}>rows again</Popover>);
  expect(popover.style.left).toBe(`${1024 - 480 - 12}px`);
});

it("re-clamps when the anchor point moves", () => {
  mockPopoverRect(300, 150);
  const view = render(
    <Popover label="References" x={40} y={60} onClose={vi.fn()}
             remeasure={[]}>body</Popover>);
  const popover = screen.getByRole("dialog", { name: "References" });
  expect(popover.style.left).toBe("40px");
  view.rerender(
    <Popover label="References" x={90} y={110} onClose={vi.fn()}
             remeasure={[]}>body</Popover>);
  expect(popover.style.left).toBe("90px");
  expect(popover.style.top).toBe("110px");
});

it("closes on Escape and on an outside mousedown, but not on one inside", () => {
  mockPopoverRect(300, 150);
  const onClose = vi.fn();
  render(<Popover label="References" x={0} y={0} onClose={onClose}
                  remeasure={[]}>body</Popover>);
  fireEvent.mouseDown(screen.getByRole("dialog", { name: "References" }));
  expect(onClose).not.toHaveBeenCalled();
  fireEvent.mouseDown(document.body);
  expect(onClose).toHaveBeenCalledTimes(1);
  fireEvent.keyDown(document, { key: "Escape" });
  expect(onClose).toHaveBeenCalledTimes(2);
});
