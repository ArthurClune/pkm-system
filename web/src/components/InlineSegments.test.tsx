import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ROUTER_FUTURE_FLAGS } from "../router";
import { expect, it, vi } from "vitest";
import type { BlockRefText } from "../api/payloads";
import { BlockRefContext, SidebarContext } from "../contexts";
import { tokenizeBlock } from "../grammar/tokenize";
import { InlineSegments } from "./InlineSegments";

// See MermaidDiagram.test.tsx: vi.mock factories are hoisted, so any
// closed-over variable must be named "mock*" for Vitest to rewire it safely.
const mockMermaidRender = vi.fn().mockResolvedValue({ svg: "<svg data-testid=\"mermaid-svg\"></svg>" });
vi.mock("mermaid", () => ({
  default: { initialize: vi.fn(), render: mockMermaidRender },
}));

vi.mock("./PdfViewer", () => ({
  PdfViewer: ({ href }: { href: string }) => <div data-testid="pdf-viewer" data-href={href} />,
}));

function renderText(text: string, refTexts: Record<string, BlockRefText> = {}) {
  return render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
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

it("renders attributes as a label link without the :: markup", () => {
  const { container } = renderText("Tags:: #AI");
  expect(screen.getByRole("link", { name: "Tags" }))
    .toHaveAttribute("href", "/page/Tags");
  expect(container.textContent).not.toContain("::");
});

it("renders fenced code inside pre.code-block", () => {
  const { container } = renderText("```python\nx = 1\n```");
  const pre = container.querySelector("pre.code-block");
  expect(pre).not.toBeNull();
  expect(pre!.textContent).toContain("x = 1");
});

it("renders a mermaid fence as a diagram, not a plain code block", async () => {
  const { container } = renderText("```mermaid\ngraph TD\na-->b\n```");
  await waitFor(() => {
    expect(container.querySelector('svg[data-testid="mermaid-svg"]')).not.toBeNull();
  });
  expect(container.querySelector("pre.code-block")).toBeNull();
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

it("renders images, pdf embeds for /assets/*.pdf links, and external links", async () => {
  const sha = "ab".repeat(32);
  const { container } = renderText(
    `![shot](/assets/${sha}/pic.png) [Notes](/assets/${sha}/doc.pdf) [ext](https://x.org)`);
  expect(container.querySelector(`img[src="/assets/${sha}/pic.png"]`)).not.toBeNull();
  // the PDF link becomes the lazy viewer wrapper: link fallback first…
  expect(screen.getByRole("link", { name: "Notes" }))
    .toHaveAttribute("href", `/assets/${sha}/doc.pdf`);
  // …then the (mocked) viewer once the chunk resolves
  await waitFor(() =>
    expect(screen.getByTestId("pdf-viewer"))
      .toHaveAttribute("data-href", `/assets/${sha}/doc.pdf`));
  expect(screen.getByRole("link", { name: "ext" }))
    .toHaveAttribute("target", "_blank");
});

it("renders a Bluesky post link as an embedded iframe, not a plain anchor", async () => {
  // embed.bsky.app only accepts DIDs, so the handle is resolved first (pkm-es9o)
  const did = "did:plc:z72i7hdynmk6r22z27h6tvur";
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: true, status: 200, json: async () => ({ did }),
  }));
  try {
    const { container } = renderText(
      "[post](https://bsky.app/profile/inline-segs.bsky.social/post/3k2abc123xy)");
    await waitFor(() => {
      expect(container.querySelector("iframe.bluesky-embed")).not.toBeNull();
    });
    const src = new URL(
      container.querySelector("iframe.bluesky-embed")!.getAttribute("src")!);
    expect(src.origin).toBe("https://embed.bsky.app");
    expect(src.pathname).toBe(`/embed/${did}/app.bsky.feed.post/3k2abc123xy`);
    expect(src.searchParams.get("ref_url"))
      .toBe("https://bsky.app/profile/inline-segs.bsky.social/post/3k2abc123xy");
    expect(screen.queryByRole("link", { name: "post" })).toBeNull();
  } finally {
    vi.unstubAllGlobals();
  }
});

it("non-post Bluesky links stay plain external links", () => {
  renderText("[profile](https://bsky.app/profile/alice.bsky.social)");
  expect(screen.getByRole("link", { name: "profile" })).toHaveAttribute("target", "_blank");
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
    <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
      <SidebarContext.Provider value={{ openInSidebar }}>
        <InlineSegments segments={tokenizeBlock("go [[Paper]]")} />
      </SidebarContext.Provider>
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole("link", { name: "Paper" }), { shiftKey: true });
  expect(openInSidebar).toHaveBeenCalledWith("Paper");
});

it("renders {{[[pdf]]: …}} asset macros as the PDF viewer with a decoded label", async () => {
  const sha = "ab".repeat(32);
  renderText(`{{[[pdf]]: /assets/${sha}/JLnhu4GhbD-SITS%20Readiness%20Assessment.pdf}}`);
  // fallback link first (lazy chunk pending): label is the decoded filename
  expect(screen.getByRole("link", { name: "JLnhu4GhbD-SITS Readiness Assessment.pdf" }))
    .toHaveAttribute("href", `/assets/${sha}/JLnhu4GhbD-SITS%20Readiness%20Assessment.pdf`);
  await waitFor(() =>
    expect(screen.getByTestId("pdf-viewer"))
      .toHaveAttribute("data-href", `/assets/${sha}/JLnhu4GhbD-SITS%20Readiness%20Assessment.pdf`));
});

it("renders non-asset pdf macros as a safe external link, not an embed", () => {
  renderText("{{pdf: https://example.org/paper.pdf}}");
  expect(screen.getByRole("link", { name: "https://example.org/paper.pdf" }))
    .toHaveAttribute("href", "https://example.org/paper.pdf");
  expect(screen.queryByTestId("pdf-viewer")).toBeNull();
});

it("renders malformed percent-encoding in a pdf macro label as the raw filename", async () => {
  const sha = "cd".repeat(32);
  renderText(`{{pdf: /assets/${sha}/bad%2.pdf}}`);
  expect(screen.getByRole("link", { name: "bad%2.pdf" })).toBeInTheDocument();
  await waitFor(() => expect(screen.getByTestId("pdf-viewer")).toBeInTheDocument());
});
