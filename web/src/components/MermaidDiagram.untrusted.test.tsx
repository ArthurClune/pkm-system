import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { UntrustedContentContext } from "../contexts";
import { MermaidDiagram } from "./MermaidDiagram";

// Its own file so that the stock mermaid module is still unloaded when the
// first test runs: the factory below counts the imports loadMermaid makes.
// Vitest hoists vi.mock factories, so what they close over must be "mock*".
const mockBmRender = vi.fn<(src: string) => Promise<string>>();
const mockRender = vi.fn<(id: string, src: string) => Promise<{ svg: string }>>();
const mockMermaidLoads = { count: 0 };

vi.mock("./beautifulMermaid", () => ({ renderMermaid: mockBmRender }));
vi.mock("mermaid", () => {
  mockMermaidLoads.count++;
  return { default: { initialize: vi.fn(), render: mockRender } };
});

afterEach(() => {
  mockBmRender.mockReset();
  mockRender.mockReset();
});

function inReply(code: string) {
  return (
    <UntrustedContentContext.Provider value={true}>
      <MermaidDiagram code={code} />
    </UntrustedContentContext.Provider>
  );
}

it("in a reply, a diagram beautiful-mermaid can't render waits for a click before stock mermaid loads", async () => {
  mockBmRender.mockRejectedValue(new Error("unsupported diagram"));
  mockRender.mockResolvedValue({ svg: '<svg data-testid="stock-svg"></svg>' });
  const code = "gantt\ntitle gated-in-reply";
  const { container } = render(inReply(code));
  const button = await screen.findByRole("button", { name: "Render diagram" });
  expect(container.textContent).toContain("gated-in-reply");
  expect(mockMermaidLoads.count).toBe(0);
  expect(mockRender).not.toHaveBeenCalled();
  expect(container.querySelector("svg")).toBeNull();

  fireEvent.click(button);
  await waitFor(() => {
    expect(container.querySelector('svg[data-testid="stock-svg"]')).not.toBeNull();
  });
  expect(mockMermaidLoads.count).toBe(1);
  expect(mockRender.mock.calls[0][1]).toBe(code);
  expect(screen.queryByRole("button", { name: "Render diagram" })).toBeNull();
});

it("in a reply, a diagram beautiful-mermaid renders shows with no click", async () => {
  mockBmRender.mockResolvedValue('<svg data-testid="bm-svg"></svg>');
  const { container } = render(inReply("graph TD\nreply-bm-direct"));
  await waitFor(() => {
    expect(container.querySelector('svg[data-testid="bm-svg"]')).not.toBeNull();
  });
  expect(screen.queryByRole("button", { name: "Render diagram" })).toBeNull();
  expect(mockRender).not.toHaveBeenCalled();
});

it("outside a reply, the stock fallback runs on render as before", async () => {
  mockBmRender.mockRejectedValue(new Error("unsupported diagram"));
  mockRender.mockResolvedValue({ svg: '<svg data-testid="note-svg"></svg>' });
  const { container } = render(<MermaidDiagram code={"gantt\ntitle note-fallback"} />);
  await waitFor(() => {
    expect(container.querySelector('svg[data-testid="note-svg"]')).not.toBeNull();
  });
  expect(screen.queryByRole("button", { name: "Render diagram" })).toBeNull();
});

it("a stock render cached from a note still waits for a click in a reply", async () => {
  mockBmRender.mockRejectedValue(new Error("unsupported diagram"));
  mockRender.mockResolvedValue({ svg: '<svg data-testid="cached-stock-svg"></svg>' });
  const code = "gantt\ntitle cached-from-note";
  const note = render(<MermaidDiagram code={code} />);
  await waitFor(() => {
    expect(note.container.querySelector('svg[data-testid="cached-stock-svg"]')).not.toBeNull();
  });
  note.unmount();

  const reply = render(inReply(code));
  expect(screen.getByRole("button", { name: "Render diagram" })).toBeInTheDocument();
  expect(reply.container.querySelector("svg")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Render diagram" }));
  expect(reply.container.querySelector('svg[data-testid="cached-stock-svg"]')).not.toBeNull();
  expect(mockRender).toHaveBeenCalledTimes(1);
});

it("a new diagram source in a reply needs its own click", async () => {
  mockBmRender.mockRejectedValue(new Error("unsupported diagram"));
  mockRender.mockResolvedValue({ svg: "<svg></svg>" });
  const { rerender } = render(inReply("gantt\ntitle first-source"));
  fireEvent.click(await screen.findByRole("button", { name: "Render diagram" }));
  await waitFor(() => expect(mockRender).toHaveBeenCalledTimes(1));

  rerender(inReply("gantt\ntitle second-source"));
  await screen.findByRole("button", { name: "Render diagram" });
  expect(mockRender).toHaveBeenCalledTimes(1);
});
