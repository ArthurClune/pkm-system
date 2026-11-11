import { describe, expect, it } from "vitest";
import cases from "../../../shared/fixtures/registry_paths.json";
import { pathMatcher } from "./registry.ts";

describe("registry path matcher", () => {
  it("matches every case of the shared registry_paths fixture", () => {
    expect(cases.length).toBeGreaterThan(0);
    for (const { pattern, path, matches } of cases) {
      expect(pathMatcher(pattern)(path), `${pattern} vs ${path}`)
        .toBe(matches);
    }
  });
});
