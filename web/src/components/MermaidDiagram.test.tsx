import { render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MermaidDiagram } from "./MermaidDiagram";

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
  const code = "gantt\ntitle x";
  const { container } = render(<MermaidDiagram code={code} />);
  await waitFor(() => {
    expect(container.querySelector('svg[data-testid="stock-svg"]')).not.toBeNull();
  });
  expect(mockRender.mock.calls[0][1]).toBe(code);
});

it("uses a distinct stock render id per instance so two fallbacks don't collide", async () => {
  mockBmRender.mockRejectedValue(new Error("nope"));
  mockRender.mockResolvedValue({ svg: "<svg></svg>" });
  render(
    <>
      <MermaidDiagram code={"gantt\na"} />
      <MermaidDiagram code={"gantt\nb"} />
    </>,
  );
  await waitFor(() => expect(mockRender).toHaveBeenCalledTimes(2));
  const [firstId] = mockRender.mock.calls[0];
  const [secondId] = mockRender.mock.calls[1];
  expect(firstId).not.toBe(secondId);
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
  render(<MermaidDiagram code={"graph TD\na-->b"} />);
  await waitFor(() => expect(mockBmRender).toHaveBeenCalledTimes(1));
  document.documentElement.setAttribute("data-theme", "dark");
  await waitFor(() => expect(mockBmRender).toHaveBeenCalledTimes(2));
});
