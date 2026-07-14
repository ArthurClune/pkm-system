import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ROUTER_FUTURE_FLAGS } from "../router";
import { expect, it } from "vitest";
import type { BlockNode } from "../api/payloads";
import { BlockTree } from "./BlockTree";

function block(uid: string, text: string, over: Partial<BlockNode> = {}): BlockNode {
  return { uid, text, heading: null, view_type: null, collapsed: false, order_idx: 0,
           created_at: 1000, updated_at: 2000, children: [], ...over };
}

function renderTree(blocks: BlockNode[]) {
  return render(<MemoryRouter future={ROUTER_FUTURE_FLAGS}><BlockTree blocks={blocks} /></MemoryRouter>);
}

it("renders nested blocks with heading levels", () => {
  renderTree([
    block("uid_a1", "Papers", { heading: 2, children: [
      block("uid_a2", "read [[Paper]]"),
    ] }),
  ]);
  const heading = screen.getByText("Papers");
  expect(heading.closest("h2")).not.toBeNull();
  expect(screen.getByRole("link", { name: "Paper" })).toBeInTheDocument();
});

it("respects the collapsed initial state and toggles on chevron click", () => {
  renderTree([
    block("uid_a1", "parent", { collapsed: true, children: [
      block("uid_a2", "hidden child"),
    ] }),
  ]);
  expect(screen.queryByText("hidden child")).toBeNull();
  fireEvent.click(screen.getAllByRole("button", { name: "toggle children" })[0]);
  expect(screen.getByText("hidden child")).toBeInTheDocument();
});

it("hides the chevron on childless blocks", () => {
  const { container } = renderTree([block("uid_a1", "leaf")]);
  expect(container.querySelector(".chevron.hidden")).not.toBeNull();
});

it("bullet shows the closed ring only when collapsed with children", () => {
  const { container } = renderTree([
    block("uid_a1", "parent", { collapsed: true, children: [block("uid_a2", "child")] }),
    block("uid_a3", "leaf", { collapsed: true }),
  ]);
  expect(container.querySelector('[data-uid="uid_a1"] .bullet.closed')).not.toBeNull();
  expect(container.querySelector('[data-uid="uid_a3"] .bullet.closed')).toBeNull();
});

it("renders exact-prefix quote content with inline segments but hides the prefix", () => {
  const { container } = renderTree([
    block("uid_q1", "> **quoted** [[World]]"),
    block("uid_q2", "ordinary > text"),
  ]);
  const quote = container.querySelector('[data-uid="uid_q1"] .quote-block');
  expect(quote).not.toBeNull();
  expect(quote).toHaveTextContent("quoted World");
  expect(quote).not.toHaveTextContent("> ");
  expect(quote!.querySelector("strong")).toHaveTextContent("quoted");
  expect(screen.getByRole("link", { name: "World" })).toBeInTheDocument();
  expect(container.querySelector('[data-uid="uid_q2"] .quote-block')).toBeNull();
});
