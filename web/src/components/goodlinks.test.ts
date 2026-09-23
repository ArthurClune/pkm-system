import { describe, expect, test } from "vitest";
import { goodlinksIdFromHref, isGoodlinksHref } from "./goodlinks";

const ID = "e4966bb2483b5c78f658398c0ae7b03f";

describe("isGoodlinksHref", () => {
  test.each([
    [`/api/goodlinks/${ID}`, true],
    [`/api/goodlinks/${ID.toUpperCase()}`, false],
    [`/api/goodlinks/${ID.slice(0, 31)}`, false],
    [`/api/goodlinks/${ID}?x=1`, false],
    ["/api/goodlinks/check", false],
    ["/api/local/Papers/a.pdf", false],
    [`https://example.com/api/goodlinks/${ID}`, false],
  ])("%s -> %s", (href, expected) => {
    expect(isGoodlinksHref(href)).toBe(expected);
  });
});

test("goodlinksIdFromHref returns the id or null", () => {
  expect(goodlinksIdFromHref(`/api/goodlinks/${ID}`)).toBe(ID);
  expect(goodlinksIdFromHref("/api/goodlinks/nope")).toBeNull();
});
