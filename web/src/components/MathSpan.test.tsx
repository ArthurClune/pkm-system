import { render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MathSpan } from "./MathSpan";

// See MermaidDiagram.test.tsx: vi.mock factories are hoisted, so any
// closed-over variable must be named "mock*" for Vitest to rewire it safely.
const mockRenderToString = vi.fn();

vi.mock("katex", () => ({
  default: { renderToString: mockRenderToString },
}));

afterEach(() => {
  mockRenderToString.mockReset();
});

it("renders KaTeX HTML for valid inline TeX", async () => {
  mockRenderToString.mockReturnValue('<span class="katex">x²</span>');
  const { container } = render(<MathSpan tex="x^2" display={false} />);
  await waitFor(() => expect(container.querySelector(".katex")).not.toBeNull());
  expect(mockRenderToString).toHaveBeenCalledWith("x^2",
    { displayMode: false, throwOnError: true });
  expect(container.querySelector("span.math-inline")).not.toBeNull();
  expect(container.querySelector(".math-display")).toBeNull();
});

it("renders display math in a block-level math-display wrapper", async () => {
  mockRenderToString.mockReturnValue('<span class="katex-display"><span class="katex">∑</span></span>');
  const { container } = render(<MathSpan tex={"\\sum_i i"} display={true} />);
  await waitFor(() => expect(container.querySelector(".katex")).not.toBeNull());
  expect(mockRenderToString).toHaveBeenCalledWith("\\sum_i i",
    { displayMode: true, throwOnError: true });
  expect(container.querySelector("span.math-display")).not.toBeNull();
});

it("falls back to the raw delimited source when KaTeX throws", async () => {
  mockRenderToString.mockImplementation(() => { throw new Error("ParseError"); });
  const { container } = render(<MathSpan tex={"\\frac{"} display={false} />);
  await waitFor(() => expect(container.querySelector(".math-error")).not.toBeNull());
  expect(container.textContent).toBe("$$\\frac{$$");
  expect(container.querySelector(".katex")).toBeNull();
});

it("shows the raw source while KaTeX is loading (no blank flash)", () => {
  mockRenderToString.mockReturnValue('<span class="katex">x</span>');
  const { container } = render(<MathSpan tex="x" display={false} />);
  // synchronously after mount, before the lazy import resolves
  expect(container.textContent).toBe("$$x$$");
});

// Each test below that renders successfully uses a distinct `tex` string:
// the (display, tex) render cache is module-level and intentionally never
// reset (that's the point of caching -- see CodeBlock.test.tsx's identical
// note about its highlight cache), so tests sharing a (display, tex) pair
// would see each other's cached HTML instead of exercising their own
// scenario. The KaTeX-throws test above is exempt: errors are never cached.

it("reuses cached KaTeX HTML across a remount, never re-invoking katex.renderToString", async () => {
  mockRenderToString.mockReturnValue('<span class="katex">cache-hit</span>');
  const first = render(<MathSpan tex="cache-reuse" display={false} />);
  await waitFor(() => expect(first.container.querySelector(".katex")).not.toBeNull());
  expect(mockRenderToString).toHaveBeenCalledTimes(1);
  first.unmount();

  const second = render(<MathSpan tex="cache-reuse" display={false} />);
  // No waitFor: a cache hit resolves synchronously within the mount effect,
  // without awaiting loadKatex()'s dynamic import -- so the HTML must
  // already be present right after render(), before any microtask runs.
  expect(second.container.querySelector(".katex")).not.toBeNull();
  expect(mockRenderToString).toHaveBeenCalledTimes(1); // still 1: never invoked again
});

it("keys the cache on display mode as well as tex: inline and display renders of the same tex don't share a cache entry", async () => {
  mockRenderToString.mockImplementation((_tex: string, opts: { displayMode: boolean }) => (
    `<span class="katex">${opts.displayMode ? "display" : "inline"}</span>`
  ));
  const inline = render(<MathSpan tex="cache-per-mode" display={false} />);
  await waitFor(() => expect(inline.container.querySelector(".katex")).not.toBeNull());
  const display = render(<MathSpan tex="cache-per-mode" display={true} />);
  await waitFor(() => expect(display.container.querySelector(".katex")).not.toBeNull());
  expect(mockRenderToString).toHaveBeenCalledTimes(2);
  expect(inline.container.textContent).toContain("inline");
  expect(display.container.textContent).toContain("display");
});

it("never caches a KaTeX error, so a remount retries rendering", async () => {
  mockRenderToString.mockImplementation(() => { throw new Error("ParseError"); });
  const first = render(<MathSpan tex={"not-cacheable-error"} display={false} />);
  await waitFor(() => expect(first.container.querySelector(".math-error")).not.toBeNull());
  expect(mockRenderToString).toHaveBeenCalledTimes(1);
  first.unmount();

  const second = render(<MathSpan tex={"not-cacheable-error"} display={false} />);
  await waitFor(() => expect(second.container.querySelector(".math-error")).not.toBeNull());
  expect(mockRenderToString).toHaveBeenCalledTimes(2); // retried, not served a cached error
});
