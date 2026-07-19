import { describe, expect, test } from "vitest";
import { applyCompletion, detectAutocomplete,
         holdsDraftFlush } from "./autocomplete";

describe("detectAutocomplete", () => {
  test("open [[ before the cursor", () => {
    expect(detectAutocomplete("see [[Ma", 8)).toEqual(
      { kind: "ref", start: 6, query: "Ma" });
    expect(detectAutocomplete("see [[", 6)).toEqual(
      { kind: "ref", start: 6, query: "" });
  });

  test("#[[ counts as a ref context", () => {
    expect(detectAutocomplete("tag #[[Lo", 9)).toEqual(
      { kind: "ref", start: 7, query: "Lo" });
  });

  test("closed [[..]] does not trigger", () => {
    expect(detectAutocomplete("see [[Done]] after", 18)).toBeNull();
  });

  test("# with at least one tag char", () => {
    expect(detectAutocomplete("a #ta", 5)).toEqual(
      { kind: "tag", start: 3, query: "ta" });
    expect(detectAutocomplete("#x", 2)).toEqual(
      { kind: "tag", start: 1, query: "x" });
    expect(detectAutocomplete("a #", 3)).toBeNull(); // bare # stays quiet
    expect(detectAutocomplete("word#x", 6)).toBeNull(); // mid-word # is not a tag
  });

  test("cursor position matters", () => {
    expect(detectAutocomplete("see [[Ma", 4)).toBeNull();
  });

  test("slash triggers a command context at block start or after whitespace", () => {
    expect(detectAutocomplete("/", 1)).toEqual({ kind: "command", start: 1, query: "" });
    expect(detectAutocomplete("/py", 3)).toEqual({ kind: "command", start: 1, query: "py" });
    expect(detectAutocomplete("hello /py", 9)).toEqual({ kind: "command", start: 7, query: "py" });
  });

  test("slash glued to the previous character does not trigger (quiet in URLs/paths)", () => {
    expect(detectAutocomplete("https://example.com", 8)).toBeNull();
    expect(detectAutocomplete("path/to/x", 5)).toBeNull();
  });

  test("a space (or other non-letter) after the slash closes the command context", () => {
    expect(detectAutocomplete("/py ", 4)).toBeNull();
    expect(detectAutocomplete("/py-thon", 8)).toBeNull();
  });

  test("digits after a leading letter still trigger (for /h1, /h2, /h3)", () => {
    expect(detectAutocomplete("/h1", 3)).toEqual({ kind: "command", start: 1, query: "h1" });
    expect(detectAutocomplete("/h", 2)).toEqual({ kind: "command", start: 1, query: "h" });
    expect(detectAutocomplete("hello /h2", 9)).toEqual({ kind: "command", start: 7, query: "h2" });
  });

  test("a leading digit does not trigger (quiet in dates/numbers)", () => {
    expect(detectAutocomplete("a /2020 budget", 7)).toBeNull();
    expect(detectAutocomplete("/1", 2)).toBeNull();
  });
});

describe("holdsDraftFlush", () => {
  test("holds while the caret is inside an open [[ ref", () => {
    // auto-pair leaves "[[How LLM]]" with the caret before the closer
    expect(holdsDraftFlush(detectAutocomplete("[[How LLM]]", 9))).toBe(true);
    expect(holdsDraftFlush(detectAutocomplete("see [[", 6))).toBe(true);
  });

  test("holds mid #tag token", () => {
    expect(holdsDraftFlush(detectAutocomplete("a #ta", 5))).toBe(true);
  });

  test("does not hold for slash commands, closed refs, or plain text", () => {
    expect(holdsDraftFlush(detectAutocomplete("/py", 3))).toBe(false);
    expect(holdsDraftFlush(detectAutocomplete("see [[Done]] after", 18)))
      .toBe(false);
    expect(holdsDraftFlush(null)).toBe(false);
  });
});

describe("applyCompletion", () => {
  test("ref: inserts title and closes brackets", () => {
    expect(applyCompletion("see [[Ma tail", 8,
                           { kind: "ref", start: 6, query: "Ma" },
                           "Machine Learning"))
      .toEqual({ text: "see [[Machine Learning]] tail", cursor: 24 });
  });

  test("ref: consumes an already-typed closer instead of doubling it", () => {
    expect(applyCompletion("see [[Ma]]", 8,
                           { kind: "ref", start: 6, query: "Ma" },
                           "Machine Learning"))
      .toEqual({ text: "see [[Machine Learning]]", cursor: 24 });
  });

  test("tag: plain for simple titles, #[[..]] for spaced ones", () => {
    expect(applyCompletion("a #ta", 5, { kind: "tag", start: 3, query: "ta" },
                           "tasks"))
      .toEqual({ text: "a #tasks", cursor: 8 });
    expect(applyCompletion("a #ta", 5, { kind: "tag", start: 3, query: "ta" },
                           "Machine Learning"))
      .toEqual({ text: "a #[[Machine Learning]]", cursor: 23 });
  });
});
