import { afterEach, expect, it, vi } from "vitest";
import { isBuildStale, noteServedBuild, resetStaleBuild,
         subscribeStaleBuild } from "./staleBuild";

afterEach(() => resetStaleBuild());

it("turns stale on a different served build and tells subscribers once", () => {
  const listener = vi.fn();
  subscribeStaleBuild(listener);
  noteServedBuild("b", "a");
  noteServedBuild("c", "a");
  expect(isBuildStale()).toBe(true);
  expect(listener).toHaveBeenCalledOnce();
});

it("stays stale once seen, even if a later response matches", () => {
  noteServedBuild("b", "a");
  noteServedBuild("a", "a");
  expect(isBuildStale()).toBe(true);
});

it("stays fresh when the server names no build", () => {
  noteServedBuild(null, "a");
  expect(isBuildStale()).toBe(false);
});

it("stops telling a listener after it unsubscribes", () => {
  const listener = vi.fn();
  subscribeStaleBuild(listener)();
  noteServedBuild("b", "a");
  expect(listener).not.toHaveBeenCalled();
});
