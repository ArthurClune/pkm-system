import { fireEvent, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { expect, it, vi } from "vitest";
import { InertMediaContext } from "../contexts";
import { ClickToLoad } from "./ClickToLoad";

// Stands in for media that fetches when it mounts.
function Probe({ onMount }: { onMount: () => void }) {
  useEffect(onMount, [onMount]);
  return <span>loaded media</span>;
}

it("mounts its children only after the click", () => {
  const onMount = vi.fn();
  render(
    <ClickToLoad revealKey="a" label="load a">
      <Probe onMount={onMount} />
    </ClickToLoad>,
  );
  expect(onMount).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "load a" }));
  expect(onMount).toHaveBeenCalledTimes(1);
  expect(screen.getByText("loaded media")).toBeInTheDocument();
});

it("shows the preview beside the placeholder until the click, then drops it", () => {
  render(
    <ClickToLoad revealKey="a" label="load a" preview={<pre>source</pre>}>
      <span>loaded media</span>
    </ClickToLoad>,
  );
  expect(screen.getByText("source")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "load a" }));
  expect(screen.queryByText("source")).toBeNull();
});

it("a new key needs its own click, and so does returning to the old one", () => {
  const onMount = vi.fn();
  const { rerender } = render(
    <ClickToLoad revealKey="a" label="load a"><Probe onMount={onMount} /></ClickToLoad>,
  );
  fireEvent.click(screen.getByRole("button", { name: "load a" }));
  onMount.mockClear();
  rerender(<ClickToLoad revealKey="b" label="load b"><Probe onMount={onMount} /></ClickToLoad>);
  expect(onMount).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "load b" })).toBeInTheDocument();
  rerender(<ClickToLoad revealKey="a" label="load a"><Probe onMount={onMount} /></ClickToLoad>);
  expect(onMount).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "load a" })).toBeInTheDocument();
});

it("a reveal from the focused placeholder moves focus to the revealed media", () => {
  render(
    <ClickToLoad revealKey="a" label="load a"><span>loaded media</span></ClickToLoad>,
  );
  const button = screen.getByRole("button", { name: "load a" });
  button.focus();
  // Enter or Space on a focused button fires click
  fireEvent.click(button);
  const wrapper = screen.getByText("loaded media").parentElement;
  expect(wrapper).toHaveClass("click-to-load-revealed");
  expect(document.activeElement).toBe(wrapper);
});

it("a reveal from an unfocused placeholder leaves focus where it was", () => {
  render(
    <>
      <input aria-label="elsewhere" />
      <ClickToLoad revealKey="a" label="load a"><span>loaded media</span></ClickToLoad>
    </>,
  );
  const elsewhere = screen.getByRole("textbox", { name: "elsewhere" });
  elsewhere.focus();
  fireEvent.click(screen.getByRole("button", { name: "load a" }));
  expect(document.activeElement).toBe(elsewhere);
});

it("the click does not reach ancestors", () => {
  const onParentClick = vi.fn();
  render(
    <div onClick={onParentClick}>
      <ClickToLoad revealKey="a" label="load a"><span>loaded media</span></ClickToLoad>
    </div>,
  );
  fireEvent.click(screen.getByRole("button", { name: "load a" }));
  expect(onParentClick).not.toHaveBeenCalled();
  expect(screen.getByText("loaded media")).toBeInTheDocument();
});

it("inside InertMediaContext the placeholder is plain text", () => {
  render(
    <InertMediaContext.Provider value={true}>
      <ClickToLoad revealKey="a" label="load a"><span>loaded media</span></ClickToLoad>
    </InertMediaContext.Provider>,
  );
  expect(screen.queryByRole("button")).toBeNull();
  expect(screen.getByText("load a")).toHaveClass("external-media-placeholder");
  expect(screen.queryByText("loaded media")).toBeNull();
});
