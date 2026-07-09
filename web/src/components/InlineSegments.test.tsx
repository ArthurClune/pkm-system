import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { expect, it, vi } from "vitest";
import type { BlockRefText } from "../api/payloads";
import { BlockRefContext, SidebarContext } from "../contexts";
import { tokenizeBlock } from "../grammar/tokenize";
import { InlineSegments } from "./InlineSegments";

function renderText(text: string, refTexts: Record<string, BlockRefText> = {}) {
  return render(
    <MemoryRouter>
      <BlockRefContext.Provider value={refTexts}>
        <InlineSegments segments={tokenizeBlock(text)} />
      </BlockRefContext.Provider>
    </MemoryRouter>,
  );
}

it("renders page links with namespace-preserving hrefs", () => {
  renderText("see [[AWS/SCP]]");
  expect(screen.getByRole("link", { name: "AWS/SCP" }))
    .toHaveAttribute("href", "/page/AWS/SCP");
});

it("renders tags with a # prefix and tag class", () => {
  renderText("about #AI");
  const link = screen.getByRole("link", { name: "#AI" });
  expect(link).toHaveClass("tag");
  expect(link).toHaveAttribute("href", "/page/AI");
});

it("renders attributes as a link to the attribute page followed by ::", () => {
  renderText("Tags:: #AI");
  expect(screen.getByRole("link", { name: "Tags" }))
    .toHaveAttribute("href", "/page/Tags");
});

it("renders fenced code inside pre.code-block", () => {
  const { container } = renderText("```python\nx = 1\n```");
  const pre = container.querySelector("pre.code-block");
  expect(pre).not.toBeNull();
  expect(pre!.textContent).toContain("x = 1");
});

it("resolves block refs from context and falls back to the literal", () => {
  renderText("See ((abc123XYZ))",
    { abc123XYZ: { text: "resolved [[Paper]]", page_title: "Papers" } });
  expect(screen.getByText(/resolved/)).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Paper" })).toBeInTheDocument();
});

it("renders unresolved block refs as the literal uid", () => {
  renderText("See ((zzz999zzz))");
  expect(screen.getByText("((zzz999zzz))")).toBeInTheDocument();
});

it("renders read-only TODO/DONE checkboxes", () => {
  renderText("{{[[TODO]]}} buy milk");
  const box = screen.getByRole("checkbox");
  expect(box).not.toBeChecked();
  expect(box).toBeDisabled();
  expect(screen.getByText("buy milk")).toBeInTheDocument();
});

it("renders images, pdf embeds for /assets/*.pdf links, and external links", () => {
  const sha = "ab".repeat(32);
  const { container } = renderText(
    `![shot](/assets/${sha}/pic.png) [Notes](/assets/${sha}/doc.pdf) [ext](https://x.org)`);
  expect(container.querySelector(`img[src="/assets/${sha}/pic.png"]`)).not.toBeNull();
  expect(container.querySelector(`embed[src="/assets/${sha}/doc.pdf"]`)).not.toBeNull();
  expect(screen.getByRole("link", { name: "Notes" }))
    .toHaveAttribute("href", `/assets/${sha}/doc.pdf`);
  expect(screen.getByRole("link", { name: "ext" }))
    .toHaveAttribute("target", "_blank");
});

it("javascript: links render as plain text, not anchors", () => {
  // nested parens in the URL trip up the naive markdown-link scanner
  // (unrelated pre-existing limitation), so keep this href paren-free.
  renderText("[x](javascript:alert)");
  expect(screen.getByText("x")).toBeInTheDocument();
  expect(screen.queryByRole("link")).toBeNull();
});

it("relative and mailto links stay clickable", () => {
  renderText("[m](mailto:a@b.c) [r](/assets/x/y.png)");
  expect(screen.getByRole("link", { name: "m" })).toHaveAttribute("href", "mailto:a@b.c");
  expect(screen.getByRole("link", { name: "r" })).toHaveAttribute("href", "/assets/x/y.png");
});

it("protocol-relative and escaped pseudo-relative hrefs render as plain text", () => {
  // Browsers normalize \ to / and strip tab/CR/LF before URL parsing, so
  // each of these would resolve to an external origin if left as an anchor.
  const { container } = renderText("[a](//evil.com) [b](/\\evil.com) [c](/\t/evil.com)");
  expect(container).toHaveTextContent("a b c");
  expect(screen.queryByRole("link")).toBeNull();
});

it("shift-click calls the sidebar callback instead of navigating", () => {
  const openInSidebar = vi.fn();
  render(
    <MemoryRouter>
      <SidebarContext.Provider value={{ openInSidebar }}>
        <InlineSegments segments={tokenizeBlock("go [[Paper]]")} />
      </SidebarContext.Provider>
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole("link", { name: "Paper" }), { shiftKey: true });
  expect(openInSidebar).toHaveBeenCalledWith("Paper");
});
