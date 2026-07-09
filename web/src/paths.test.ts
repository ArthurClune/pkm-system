import { describe, expect, it } from "vitest";
import { encodeTitle, pagePath, titleFromPathname } from "./paths";

describe("encodeTitle / pagePath", () => {
  it("percent-encodes each segment but keeps '/' literal for namespace titles", () => {
    expect(encodeTitle("Machine Learning")).toBe("Machine%20Learning");
    expect(encodeTitle("AI/Sub Topic")).toBe("AI/Sub%20Topic");
    expect(pagePath("Machine Learning")).toBe("/page/Machine%20Learning");
  });
});

describe("titleFromPathname", () => {
  it("decodes a simple encoded title", () => {
    expect(titleFromPathname("/page/Machine%20Learning")).toBe("Machine Learning");
  });

  it("round-trips a namespace title through encodeTitle/pagePath", () => {
    expect(titleFromPathname(pagePath("AI/Sub Topic"))).toBe("AI/Sub Topic");
  });

  it("falls back to the raw segment when decodeURIComponent would throw", () => {
    // A lone "%" is not valid percent-encoding and throws a URIError from
    // decodeURIComponent; a hand-typed URL like this must not crash the app.
    expect(titleFromPathname("/page/100%")).toBe("100%");
  });
});
