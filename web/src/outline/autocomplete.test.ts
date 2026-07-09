import { describe, expect, test } from "vitest";
import { applyCompletion, detectAutocomplete } from "./autocomplete";

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
