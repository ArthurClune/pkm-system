import { describe, expect, test } from "vitest";
import { CONTEXT_GROUPS, expandOnly } from "./contextGroups.mjs";

describe("expandOnly", () => {
  test("a letter expands to its whole browser-context group", () => {
    expect([...expandOnly("H")].sort()).toEqual(["H", "W"]);
    expect([...expandOnly("F")].sort()).toEqual(["A", "B", "F", "I"]);
    expect([...expandOnly("K,S")].sort()).toEqual(["J", "K", "S"]);
    expect([...expandOnly("R")]).toEqual(["R"]);
  });

  test("groups partition the letters, each in exactly one", () => {
    const all = CONTEXT_GROUPS.flatMap((g: string) => [...g]);
    expect(new Set(all).size).toBe(all.length);
  });

  test("an unknown letter is kept so the caller can refuse it", () => {
    expect([...expandOnly("Z")]).toEqual(["Z"]);
  });
});
