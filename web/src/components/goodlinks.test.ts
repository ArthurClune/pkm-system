import { describe, expect, test } from "vitest";
import { goodlinksIdFromHref } from "./goodlinks";

const ID = "e4966bb2483b5c78f658398c0ae7b03f";

describe("goodlinksIdFromHref", () => {
  test.each([
    [`/api/goodlinks/${ID}`, ID],
    [`/api/goodlinks/${ID.toUpperCase()}`, null],
    [`/api/goodlinks/${ID.slice(0, 31)}`, null],
    [`/api/goodlinks/${ID}?x=1`, null],
    ["/api/goodlinks/check", null],
    ["/api/local/Papers/a.pdf", null],
    [`https://example.com/api/goodlinks/${ID}`, null],
  ])("%s -> %s", (href, expected) => {
    expect(goodlinksIdFromHref(href)).toBe(expected);
  });
});
