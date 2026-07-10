import { describe, expect, it } from "vitest";
import { isSidebarState, toggleSidebarState } from "./sidebar";

describe("isSidebarState", () => {
  it("accepts the two valid states", () => {
    expect(isSidebarState("open")).toBe(true);
    expect(isSidebarState("collapsed")).toBe(true);
  });

  it("rejects anything else, including null/undefined", () => {
    expect(isSidebarState("hidden")).toBe(false);
    expect(isSidebarState("")).toBe(false);
    expect(isSidebarState(null)).toBe(false);
    expect(isSidebarState(undefined)).toBe(false);
  });
});

describe("toggleSidebarState", () => {
  it("flips open <-> collapsed", () => {
    expect(toggleSidebarState("open")).toBe("collapsed");
    expect(toggleSidebarState("collapsed")).toBe("open");
  });
});
