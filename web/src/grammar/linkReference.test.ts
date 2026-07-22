import { describe, expect, test } from "vitest";
import { linkUnlinkedReference } from "./linkReference";

const linked = (text: string, title: string) =>
  linkUnlinkedReference(text, title);

describe("linkUnlinkedReference", () => {
  test("links the first differently cased plain occurrence using canonical casing", () => {
    expect(linked("Acme created Acme", "ACME")).toEqual({
      status: "linked",
      match: "plain",
      text: "[[ACME]] created Acme",
    });
  });

  test("enforces alphanumeric title boundaries", () => {
    expect(linked("MegaACME ACMEworks Acme works", "ACME")).toEqual({
      status: "linked",
      match: "plain",
      text: "MegaACME ACMEworks [[ACME]] works",
    });
  });

  test("supports multi-word and punctuation-edged titles", () => {
    expect(linked("Machine Learning notes", "Machine Learning")).toMatchObject({
      status: "linked", text: "[[Machine Learning]] notes",
    });
    expect(linked("read C++ today", "C++")).toMatchObject({
      status: "linked", text: "read [[C++]] today",
    });
  });

  test.each([
    ["[ACME study](https://example.test)", "label"],
    ["[A study](https://acme.test/study)", "destination"],
  ])("appends a canonical tag for a Markdown %s match", (text) => {
    expect(linked(text, "ACME")).toEqual({
      status: "linked", match: "markdown", text: `${text} #[[ACME]]`,
    });
  });

  test("prefers an eligible plain occurrence over a Markdown match", () => {
    expect(linked("[ACME](https://acme.test) by Acme", "ACME")).toEqual({
      status: "linked",
      match: "plain",
      text: "[ACME](https://acme.test) by [[ACME]]",
    });
  });

  test("protects references, tags, code, and images", () => {
    const text = "[[ACME]] #[[ACME]] #ACME ((ACME12)) `ACME` ```ACME``` ![ACME](acme.png)";
    expect(linked(text, "ACME")).toEqual({ status: "no-safe-match" });
  });

  test("does not treat Markdown images as fallback links", () => {
    expect(linked("![ACME](https://acme.test/image.png)", "ACME"))
      .toEqual({ status: "no-safe-match" });
  });

  test("adds no duplicate separator when a Markdown block ends in whitespace", () => {
    expect(linked("[ACME](https://example.test) ", "ACME")).toMatchObject({
      text: "[ACME](https://example.test) #[[ACME]]",
    });
  });

  test("returns no-safe-match for an empty title or absent title", () => {
    expect(linked("ACME", "")).toEqual({ status: "no-safe-match" });
    expect(linked("unrelated", "ACME")).toEqual({ status: "no-safe-match" });
  });
});
