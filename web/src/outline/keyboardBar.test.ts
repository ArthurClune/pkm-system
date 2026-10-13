import { describe, expect, it } from "vitest";
import { insertTypedChar, isPhoneUserAgent, KEYBOARD_BAR_KEYS,
         keyboardInset } from "./keyboardBar";

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 26_5 like Mac OS X) "
  + "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5 Mobile/15E148 Safari/604.1";
const IPAD_DESKTOP_MODE = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
  + "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5 Safari/605.1.15";
const IPAD_MOBILE_MODE = "Mozilla/5.0 (iPad; CPU OS 26_5 like Mac OS X) "
  + "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5 Mobile/15E148 Safari/604.1";
const DESKTOP_CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
  + "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

describe("isPhoneUserAgent", () => {
  it("is true for an iPhone", () => {
    expect(isPhoneUserAgent(IPHONE)).toBe(true);
  });

  it("is false for an iPad in either Safari mode", () => {
    expect(isPhoneUserAgent(IPAD_DESKTOP_MODE)).toBe(false);
    expect(isPhoneUserAgent(IPAD_MOBILE_MODE)).toBe(false);
  });

  it("is false for a desktop browser, however narrow its window", () => {
    expect(isPhoneUserAgent(DESKTOP_CHROME)).toBe(false);
  });
});

describe("KEYBOARD_BAR_KEYS", () => {
  it("offers indent, outdent and the two bracket pairs, in that order", () => {
    expect(KEYBOARD_BAR_KEYS.map((k) => [k.key, k.shiftKey])).toEqual([
      ["Tab", false], ["Tab", true],
      ["(", false], [")", false], ["[", false], ["]", false],
    ]);
  });

  it("names the arrow buttons for screen readers", () => {
    expect(KEYBOARD_BAR_KEYS[0]).toMatchObject({ label: "→", name: "Indent" });
    expect(KEYBOARD_BAR_KEYS[1]).toMatchObject({ label: "←", name: "Outdent" });
  });
});

describe("insertTypedChar", () => {
  it("inserts at a collapsed caret and moves past it", () => {
    expect(insertTypedChar("ab", 1, 1, ")"))
      .toEqual({ text: "a)b", selStart: 2, selEnd: 2 });
  });

  it("replaces a selection, as typing over it would", () => {
    expect(insertTypedChar("abcd", 1, 3, "]"))
      .toEqual({ text: "a]d", selStart: 2, selEnd: 2 });
  });
});

describe("keyboardInset", () => {
  it("is the strip of the layout viewport the keyboard covers", () => {
    expect(keyboardInset(800, 450, 0)).toBe(350);
  });

  it("allows for the visual viewport having scrolled down", () => {
    expect(keyboardInset(800, 450, 100)).toBe(250);
  });

  it("is never negative", () => {
    expect(keyboardInset(800, 800, 20)).toBe(0);
  });
});
