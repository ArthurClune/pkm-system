import { describe, expect, it } from "vitest";
import { isIosStandalone, safariHrefForClick } from "./externalLink";

function nav(over: Partial<{ platform: string; maxTouchPoints: number; standalone: boolean }>) {
  return {
    platform: over.platform ?? "",
    maxTouchPoints: over.maxTouchPoints ?? 0,
    standalone: over.standalone,
  };
}

const PLAIN_CLICK = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false };

describe("isIosStandalone", () => {
  it("is true for iPhone platform with standalone true", () => {
    expect(isIosStandalone(nav({ platform: "iPhone", standalone: true }))).toBe(true);
  });

  it("is true for iPad platform with standalone true", () => {
    expect(isIosStandalone(nav({ platform: "iPad", standalone: true }))).toBe(true);
  });

  it("is true for iPod platform with standalone true", () => {
    expect(isIosStandalone(nav({ platform: "iPod", standalone: true }))).toBe(true);
  });

  it("is true for modern iPadOS reporting MacIntel with multiple touch points", () => {
    expect(isIosStandalone(nav({ platform: "MacIntel", maxTouchPoints: 5, standalone: true })))
      .toBe(true);
  });

  it("is false for MacIntel with a single touch point (real Mac trackpad-ish)", () => {
    expect(isIosStandalone(nav({ platform: "MacIntel", maxTouchPoints: 1, standalone: true })))
      .toBe(false);
  });

  it("is false for MacIntel with no touch points", () => {
    expect(isIosStandalone(nav({ platform: "MacIntel", maxTouchPoints: 0, standalone: true })))
      .toBe(false);
  });

  it("is false when standalone is not true, even on iOS platform", () => {
    expect(isIosStandalone(nav({ platform: "iPhone", standalone: false }))).toBe(false);
  });

  it("is false when standalone is undefined", () => {
    expect(isIosStandalone(nav({ platform: "iPhone" }))).toBe(false);
  });

  it("is false for a plain desktop platform even if standalone happened to be true", () => {
    expect(isIosStandalone(nav({ platform: "Win32", standalone: true }))).toBe(false);
  });
});

describe("safariHrefForClick", () => {
  const origin = "https://pkm.example.com";

  it("rewrites an external https link to x-safari-https", () => {
    expect(safariHrefForClick("https://other.example.com/page", origin, PLAIN_CLICK))
      .toBe("x-safari-https://other.example.com/page");
  });

  it("rewrites an external http link to x-safari-http", () => {
    expect(safariHrefForClick("http://other.example.com/page", origin, PLAIN_CLICK))
      .toBe("x-safari-http://other.example.com/page");
  });

  it("returns null for a same-origin absolute link", () => {
    expect(safariHrefForClick("https://pkm.example.com/some/page", origin, PLAIN_CLICK))
      .toBeNull();
  });

  it("returns null for a site-relative href resolved against currentOrigin", () => {
    expect(safariHrefForClick("/some/page", origin, PLAIN_CLICK)).toBeNull();
  });

  it("returns null for a non-parseable url", () => {
    // A bare string like "not a url" resolves fine as a relative path
    // against currentOrigin; an invalid bracketed host is genuinely
    // unparseable even with a base and exercises the catch branch.
    expect(safariHrefForClick("http://[bad", origin, PLAIN_CLICK)).toBeNull();
  });

  it("returns null for mailto: links", () => {
    expect(safariHrefForClick("mailto:someone@example.com", origin, PLAIN_CLICK)).toBeNull();
  });

  it("returns null for javascript: links", () => {
    expect(safariHrefForClick("javascript:void(0)", origin, PLAIN_CLICK)).toBeNull();
  });

  it("returns null when the click used a non-primary button", () => {
    expect(safariHrefForClick("https://other.example.com/", origin,
      { ...PLAIN_CLICK, button: 1 })).toBeNull();
  });

  it("returns null when metaKey is held", () => {
    expect(safariHrefForClick("https://other.example.com/", origin,
      { ...PLAIN_CLICK, metaKey: true })).toBeNull();
  });

  it("returns null when ctrlKey is held", () => {
    expect(safariHrefForClick("https://other.example.com/", origin,
      { ...PLAIN_CLICK, ctrlKey: true })).toBeNull();
  });

  it("returns null when shiftKey is held", () => {
    expect(safariHrefForClick("https://other.example.com/", origin,
      { ...PLAIN_CLICK, shiftKey: true })).toBeNull();
  });

  it("returns null when altKey is held", () => {
    expect(safariHrefForClick("https://other.example.com/", origin,
      { ...PLAIN_CLICK, altKey: true })).toBeNull();
  });
});
