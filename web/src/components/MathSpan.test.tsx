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
