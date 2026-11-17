import { render, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { MathSpan } from "./MathSpan";

// Real katex, unmocked: MathSpan injects its output as HTML, so this pins
// that katex's default trust:false still refuses every command that could
// turn block text into a link, an image or attacker-chosen attributes.
// A katex upgrade that changes the default fails here. The \html* commands
// also warn under katex's default strict:"warn"; the warning names the code.
it.each([
  ["\\href{javascript:alert(1)}{click}", null],
  ["\\href{https://example.com}{click}", null],
  ["\\url{https://example.com}", null],
  ["\\includegraphics{https://example.com/x.png}", null],
  ["\\htmlId{planted}{x}", "htmlExtension"],
  ["\\htmlClass{planted}{x}", "htmlExtension"],
  ["\\htmlData{planted=1}{x}", "htmlExtension"],
  ["\\htmlStyle{background:url(https://example.com/x.png)}{x}",
    "htmlExtension"],
])("renders %s without a link, image or user-chosen attribute",
  async (tex, warning) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { container } = render(<MathSpan tex={tex} display={false} />);
    await waitFor(() =>
      expect(container.querySelector(".math-loading")).toBeNull());
    expect(container.querySelector(".katex")).not.toBeNull();
    expect(container.querySelector("a, img, [href], [src]")).toBeNull();
    // The TeX source survives as text in katex's MathML <annotation>, which
    // is harmless; only attributes can carry a planted id, class or URL.
    const attributes = [...container.querySelectorAll("*")]
      .flatMap((el) => [...el.attributes].map((a) => a.value));
    expect(attributes.filter((v) => /planted|example\.com/.test(v)))
      .toEqual([]);
    expect(warn.mock.calls.map(([msg]) => String(msg)))
      .toEqual(warning === null ? [] : [expect.stringContaining(warning)]);
    warn.mockRestore();
  });
