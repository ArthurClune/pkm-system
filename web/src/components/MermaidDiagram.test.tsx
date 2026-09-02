import { render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MERMAID_CACHE_RENDER_ID, MermaidDiagram } from "./MermaidDiagram";

// Vitest hoists vi.mock factories above the file's own top-level statements,
// so any variable the factory closes over must be named "mock*" -- that's
// the one naming pattern Vitest's hoist transform recognises and rewires
// safely. Anything else (e.g. "renderMock") silently falls out of sync
// between calls, which is exactly the kind of intermittent flake this
// naming avoids.
const mockBmRender = vi.fn();
const mockRender = vi.fn();
const mockInitialize = vi.fn();

vi.mock("./beautifulMermaid", () => ({
  renderMermaid: mockBmRender,
}));

vi.mock("mermaid", () => ({
  default: {
    initialize: mockInitialize,
    render: mockRender,
  },
}));

afterEach(() => {
  mockBmRender.mockReset();
  mockRender.mockReset();
  document.documentElement.removeAttribute("data-theme");
  // mockInitialize is deliberately NOT reset: loadMermaid() caches the
  // module-level promise, so initialize fires exactly once per test file --
  // its first recorded call is the only record any test can assert on.
});

// Each test below that renders successfully uses a distinct `code` string:
// the (theme, code) render cache is module-level and intentionally never
// reset (that's the point of caching -- see CodeBlock.test.tsx's identical
// note about its highlight cache), so tests sharing a (theme, code) pair
// would see each other's cached SVG instead of exercising their own
// scenario. Tests that end in the error state are exempt: errors are never
// cached.

it("renders via beautiful-mermaid with token-derived options, stock mermaid untouched", async () => {
  mockBmRender.mockResolvedValue('<svg data-testid="bm-svg"></svg>');
  const code = "graph TD\na-->b";
  const { container } = render(<MermaidDiagram code={code} />);
  await waitFor(() => {
    expect(container.querySelector('svg[data-testid="bm-svg"]')).not.toBeNull();
  });
  const [srcArg, optsArg] = mockBmRender.mock.calls[0];
  expect(srcArg).toBe(code);
  expect(optsArg.font).toContain("-apple-system");
  expect(mockRender).not.toHaveBeenCalled();
});

it("initializes stock mermaid with the base theme only on fallback", async () => {
  mockBmRender.mockRejectedValue(new Error("unsupported diagram"));
  mockRender.mockResolvedValue({ svg: "<svg></svg>" });
  render(<MermaidDiagram code={"gantt\ntitle x"} />);
  await waitFor(() => expect(mockInitialize).toHaveBeenCalled());
  const [config] = mockInitialize.mock.calls[0];
  expect(config.theme).toBe("base");
  expect(config.securityLevel).toBe("strict");
  expect(config.themeVariables.fontFamily).toContain("-apple-system");
  expect(config.themeVariables.darkMode).toBe(false);
});

it("falls back to stock mermaid rendering when beautiful-mermaid rejects", async () => {
  mockBmRender.mockRejectedValue(new Error("unsupported diagram"));
  mockRender.mockResolvedValue({ svg: '<svg data-testid="stock-svg"></svg>' });
  const code = "gantt\ntitle fallback-render";
  const { container } = render(<MermaidDiagram code={code} />);
  await waitFor(() => {
    expect(container.querySelector('svg[data-testid="stock-svg"]')).not.toBeNull();
  });
  expect(mockRender.mock.calls[0][1]).toBe(code);
});

it("renders concurrent instances with distinct real ids, never the cache placeholder, so stock mermaid's DOM-based render never collides", async () => {
  mockBmRender.mockRejectedValue(new Error("nope"));
  // The mock stands in for what real mermaid.render() does: bake the id
  // argument into the returned SVG's own id attribute. If both instances
  // were ever passed the same id (e.g. the cache placeholder), stock
  // mermaid's real removeExistingElements()/render-by-DOM-id dance would
  // have the two concurrent renders clobber each other.
  mockRender.mockImplementation((id: string) => Promise.resolve({ svg: `<svg id="${id}"></svg>` }));
  const { container } = render(
    <>
      <MermaidDiagram code={"gantt\ndistinct-id-a"} />
      <MermaidDiagram code={"gantt\ndistinct-id-b"} />
    </>,
  );
  await waitFor(() => expect(mockRender).toHaveBeenCalledTimes(2));
  const [firstId] = mockRender.mock.calls[0];
  const [secondId] = mockRender.mock.calls[1];
  expect(firstId).not.toBe(MERMAID_CACHE_RENDER_ID);
  expect(secondId).not.toBe(MERMAID_CACHE_RENDER_ID);
  expect(firstId).not.toBe(secondId);
  const svgs = container.querySelectorAll("svg");
  expect(svgs).toHaveLength(2);
  expect(svgs[0].id).not.toBe(MERMAID_CACHE_RENDER_ID);
  expect(svgs[1].id).not.toBe(MERMAID_CACHE_RENDER_ID);
  expect(svgs[0].id).not.toBe(svgs[1].id);
});

it("substitutes its own id into a cache hit, never the placeholder and never the first instance's id", async () => {
  mockBmRender.mockRejectedValue(new Error("nope"));
  mockRender.mockImplementation((id: string) => Promise.resolve({ svg: `<svg id="${id}"></svg>` }));
  const code = "gantt\nshared-id-substitution";
  const first = render(<MermaidDiagram code={code} />);
  await waitFor(() => expect(mockRender).toHaveBeenCalledTimes(1));
  const firstSvg = first.container.querySelector("svg");
  const firstId = firstSvg?.id;
  expect(firstId).not.toBe(MERMAID_CACHE_RENDER_ID);
  first.unmount();

  const second = render(<MermaidDiagram code={code} />);
  // Cache hit: no further render() call at all.
  expect(mockRender).toHaveBeenCalledTimes(1);
  const secondSvg = second.container.querySelector("svg");
  expect(secondSvg?.id).not.toBe(MERMAID_CACHE_RENDER_ID);
  expect(secondSvg?.id).not.toBe(firstId);
  expect(secondSvg?.id).toBeTruthy();
});

it("falls back to a raw code block when both renderers reject, with no uncaught rejection", async () => {
  mockBmRender.mockRejectedValue(new Error("bm parse error"));
  mockRender.mockRejectedValue(new Error("Parse error on line 1"));
  const code = "not a valid diagram";
  const { container } = render(<MermaidDiagram code={code} />);
  await waitFor(() => {
    expect(container.querySelector("pre.code-block")).not.toBeNull();
  });
  expect(container.querySelector("svg")).toBeNull();
  expect(container.textContent).toContain(code);
});

it("shows a muted error note alongside the raw-source fallback", async () => {
  mockBmRender.mockRejectedValue(new Error("boom"));
  mockRender.mockRejectedValue(new Error("boom"));
  const { container } = render(<MermaidDiagram code="bad" />);
  await waitFor(() => {
    expect(container.querySelector(".mermaid-diagram-error-note")).not.toBeNull();
  });
});

it("re-renders through beautiful-mermaid when the effective theme flips", async () => {
  document.documentElement.setAttribute("data-theme", "light");
  mockBmRender.mockResolvedValue("<svg></svg>");
  render(<MermaidDiagram code={"graph TD\ntheme-flip-flow"} />);
  await waitFor(() => expect(mockBmRender).toHaveBeenCalledTimes(1));
  document.documentElement.setAttribute("data-theme", "dark");
  await waitFor(() => expect(mockBmRender).toHaveBeenCalledTimes(2));
});

it("reuses a cached render across a remount, never awaiting the loader module on a hit", async () => {
  document.documentElement.setAttribute("data-theme", "light");
  mockBmRender.mockResolvedValue('<svg data-testid="cache-hit-svg"></svg>');
  const code = "graph TD\ncache-reuse";
  const first = render(<MermaidDiagram code={code} />);
  await waitFor(() => {
    expect(first.container.querySelector('svg[data-testid="cache-hit-svg"]')).not.toBeNull();
  });
  expect(mockBmRender).toHaveBeenCalledTimes(1);
  first.unmount();

  const second = render(<MermaidDiagram code={code} />);
  // No waitFor: a cache hit resolves synchronously within the mount effect,
  // without awaiting loadBeautifulMermaid()'s dynamic import -- so the SVG
  // must already be present right after render(), before any microtask runs.
  expect(second.container.querySelector('svg[data-testid="cache-hit-svg"]')).not.toBeNull();
  expect(mockBmRender).toHaveBeenCalledTimes(1); // still 1: never invoked again
});

it("keys the cache on theme as well as code: a theme flip still re-renders instead of reusing the other theme's SVG", async () => {
  const code = "graph TD\ncache-per-theme";
  document.documentElement.setAttribute("data-theme", "light");
  mockBmRender.mockResolvedValueOnce('<svg data-testid="light-svg"></svg>');
  const first = render(<MermaidDiagram code={code} />);
  await waitFor(() => {
    expect(first.container.querySelector('svg[data-testid="light-svg"]')).not.toBeNull();
  });
  first.unmount();

  document.documentElement.setAttribute("data-theme", "dark");
  mockBmRender.mockResolvedValueOnce('<svg data-testid="dark-svg"></svg>');
  const second = render(<MermaidDiagram code={code} />);
  await waitFor(() => {
    expect(second.container.querySelector('svg[data-testid="dark-svg"]')).not.toBeNull();
  });
  expect(mockBmRender).toHaveBeenCalledTimes(2);
});

it("never caches an errored render, so a remount retries both renderers", async () => {
  const code = "not-cacheable-error";
  mockBmRender.mockRejectedValue(new Error("boom"));
  mockRender.mockRejectedValue(new Error("boom"));
  const first = render(<MermaidDiagram code={code} />);
  await waitFor(() => expect(first.container.querySelector(".mermaid-diagram-error-note")).not.toBeNull());
  expect(mockBmRender).toHaveBeenCalledTimes(1);
  first.unmount();

  const second = render(<MermaidDiagram code={code} />);
  await waitFor(() => expect(second.container.querySelector(".mermaid-diagram-error-note")).not.toBeNull());
  expect(mockBmRender).toHaveBeenCalledTimes(2); // retried, not served a cached error
});
