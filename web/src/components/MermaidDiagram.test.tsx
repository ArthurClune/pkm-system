import { render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MermaidDiagram } from "./MermaidDiagram";

// Vitest hoists vi.mock factories above the file's own top-level statements,
// so any variable the factory closes over must be named "mock*" -- that's
// the one naming pattern Vitest's hoist transform recognises and rewires
// safely. Anything else (e.g. "renderMock") silently falls out of sync
// between calls, which is exactly the kind of intermittent flake this
// naming avoids.
const mockRender = vi.fn();
const mockInitialize = vi.fn();

vi.mock("mermaid", () => ({
  default: {
    initialize: mockInitialize,
    render: mockRender,
  },
}));

afterEach(() => {
  mockRender.mockReset();
  mockInitialize.mockReset();
});

it("renders the SVG mermaid.render() resolves with", async () => {
  mockRender.mockResolvedValue({ svg: '<svg data-testid="diagram-svg"></svg>' });
  const { container } = render(<MermaidDiagram code={"graph TD\na-->b"} />);
  await waitFor(() => {
    expect(container.querySelector("svg")).not.toBeNull();
  });
  expect(container.querySelector('svg[data-testid="diagram-svg"]')).not.toBeNull();
});

it("passes the raw source to mermaid.render", async () => {
  mockRender.mockResolvedValue({ svg: "<svg></svg>" });
  const code = "graph TD\na-->b";
  render(<MermaidDiagram code={code} />);
  await waitFor(() => expect(mockRender).toHaveBeenCalled());
  expect(mockRender.mock.calls[0][1]).toBe(code);
});

it("uses a distinct render id per instance so two diagrams don't collide", async () => {
  mockRender.mockResolvedValue({ svg: "<svg></svg>" });
  render(
    <>
      <MermaidDiagram code={"graph TD\na-->b"} />
      <MermaidDiagram code={"graph TD\nc-->d"} />
    </>,
  );
  await waitFor(() => expect(mockRender).toHaveBeenCalledTimes(2));
  const [firstId] = mockRender.mock.calls[0];
  const [secondId] = mockRender.mock.calls[1];
  expect(firstId).not.toBe(secondId);
});

it("falls back to a raw code block when mermaid.render rejects, with no uncaught rejection", async () => {
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
  mockRender.mockRejectedValue(new Error("boom"));
  const { container } = render(<MermaidDiagram code="bad" />);
  await waitFor(() => {
    expect(container.querySelector(".mermaid-diagram-error-note")).not.toBeNull();
  });
});
