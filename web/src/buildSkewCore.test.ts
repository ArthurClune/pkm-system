import { expect, it } from "vitest";
import { isStaleBuild } from "./buildSkewCore";

it("is stale when the server serves another build", () => {
  expect(isStaleBuild("a", "b")).toBe(true);
});

it("is fresh when the builds match", () => {
  expect(isStaleBuild("a", "a")).toBe(false);
});

it("is fresh when the server names no build", () => {
  expect(isStaleBuild("a", null)).toBe(false);
});

it("never calls a dev bundle stale", () => {
  expect(isStaleBuild("dev", "b")).toBe(false);
});
