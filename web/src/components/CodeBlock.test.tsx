import { render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CodeBlock, HIGHLIGHT_CACHE_LIMIT, cachedHighlight } from "./CodeBlock";

// See MathSpan.test.tsx / MermaidDiagram.test.tsx: vi.mock factories are
// hoisted, so any closed-over variable must be named "mock*" for Vitest to
// rewire it safely.
const mockGetLanguage = vi.fn();
const mockHighlight = vi.fn();

vi.mock("highlight.js/lib/common", () => ({
  default: { getLanguage: mockGetLanguage, highlight: mockHighlight },
}));

afterEach(() => {
  mockGetLanguage.mockReset();
  mockHighlight.mockReset();
});

// Each test below uses a distinct code string: the highlight cache is
// module-level and intentionally never reset (that's the point of caching),
// so tests sharing a (lang, code) pair would see each other's cached HTML
// instead of exercising their own scenario.

it("shows plain unhighlighted text before the hljs chunk loads (no blank flash)", () => {
  mockGetLanguage.mockReturnValue({});
  mockHighlight.mockReturnValue({ value: '<span class="hljs-keyword">let</span> a' });
  const { container } = render(<CodeBlock lang="js" code="let a" />);
  expect(container.textContent).toBe("let a");
  expect(container.querySelector(".hljs-keyword")).toBeNull();
});

it("highlights via hljs once the lazy chunk resolves", async () => {
  mockGetLanguage.mockReturnValue({});
  mockHighlight.mockReturnValue({ value: '<span class="hljs-keyword">let</span> b' });
  const { container } = render(<CodeBlock lang="js" code="let b" />);
  await waitFor(() => expect(container.querySelector(".hljs-keyword")).not.toBeNull());
  expect(mockHighlight).toHaveBeenCalledWith("let b", { language: "js" });
});

it("renders plain code, never calling highlight, when the language is unrecognized", async () => {
  mockGetLanguage.mockReturnValue(undefined);
  const { container } = render(<CodeBlock lang="not-a-real-lang" code="raw text" />);
  // Give the lazy load a tick to resolve so a false negative isn't just
  // "hasn't loaded yet".
  await waitFor(() => expect(mockGetLanguage).toHaveBeenCalledWith("not-a-real-lang"));
  expect(container.textContent).toBe("raw text");
  expect(mockHighlight).not.toHaveBeenCalled();
});

it("renders plain code with no language tag and never fetches hljs at all", () => {
  const { container } = render(<CodeBlock lang={null} code="raw text" />);
  expect(container.textContent).toBe("raw text");
  expect(mockGetLanguage).not.toHaveBeenCalled();
});

it("caches highlighted HTML per (lang, code): a repeat render doesn't re-invoke hljs.highlight", async () => {
  mockGetLanguage.mockReturnValue({});
  mockHighlight.mockReturnValue({ value: '<span class="hljs-keyword">let</span> c' });
  const first = render(<CodeBlock lang="js" code="let c" />);
  await waitFor(() => expect(first.container.querySelector(".hljs-keyword")).not.toBeNull());
  expect(mockHighlight).toHaveBeenCalledTimes(1);

  const second = render(<CodeBlock lang="js" code="let c" />);
  await waitFor(() => expect(second.container.querySelector(".hljs-keyword")).not.toBeNull());
  expect(mockHighlight).toHaveBeenCalledTimes(1); // served from cache, not recomputed
});

it("does not share cached HTML between different languages for the same code", async () => {
  mockGetLanguage.mockReturnValue({});
  mockHighlight.mockImplementation((code: string, opts: { language: string }) => (
    { value: `hl-${opts.language}:${code}` }
  ));
  const py = render(<CodeBlock lang="python" code="x = 2" />);
  await waitFor(() => expect(py.container.textContent).toBe("hl-python:x = 2"));
  const js = render(<CodeBlock lang="js" code="x = 2" />);
  await waitFor(() => expect(js.container.textContent).toBe("hl-js:x = 2"));
  expect(mockHighlight).toHaveBeenCalledTimes(2);
});

it("bounds the highlight cache: exceeding the limit clears old entries", () => {
  let calls = 0;
  const compute = () => {
    calls += 1;
    return `v${calls}`;
  };
  const first = cachedHighlight("js", "bound-entry-0", compute);
  for (let i = 1; i <= HIGHLIGHT_CACHE_LIMIT; i++) {
    cachedHighlight("js", `bound-entry-${i}`, compute);
  }
  const callsBeforeRecompute = calls;
  const second = cachedHighlight("js", "bound-entry-0", compute);
  // The clear evicted the original entry, so it's recomputed -- a fresh
  // (distinct) value, proving the map was actually cleared, not just full.
  expect(calls).toBe(callsBeforeRecompute + 1);
  expect(second).not.toBe(first);
});
