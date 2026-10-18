import { describe, expect, test } from "vitest";
import registry from "../tooling/brandRegistry.gen.json";
import * as helpers from "./test-helpers";
import { malformedSha, malformedUid, pageIdOf, shaOf, uidOf } from "./test-helpers";

// Every web source file but the tests, to find the brands the web declares:
// those in api/brands.ts and the web-only ones declared beside their code.
const sources = import.meta.glob<string>(
  ["./**/*.{ts,tsx}", "!./**/*.test.{ts,tsx}", "!./**/*.gen.ts"],
  { query: "?raw", import: "default", eager: true },
);

function webBrands(): Set<string> {
  const found = new Set<string>();
  for (const [path, text] of Object.entries(sources)) {
    for (const m of text.matchAll(/__brand: "(\w+)"/g)) found.add(m[1]);
    if (path === "./api/brands.ts") {
      for (const m of text.matchAll(/^export type (\w+) =/gm)) found.add(m[1]);
    }
  }
  return found;
}

const capitalised = (s: string): string => s[0].toUpperCase() + s.slice(1);

describe("checked test helpers", () => {
  test("uidOf returns a uid-shaped value", () => {
    expect(uidOf("tuid-a")).toBe("tuid-a");
  });

  test("uidOf refuses a short tag and names malformedUid", () => {
    expect(() => uidOf("a")).toThrow(/malformedUid/);
  });

  test("malformedUid returns its value unchecked", () => {
    expect(malformedUid("")).toBe("");
  });

  test("an integer brand refuses a fraction", () => {
    expect(pageIdOf(3)).toBe(3);
    expect(() => pageIdOf(1.5)).toThrow(/PageId/);
  });

  test("an integer brand refuses a value that is not a number", () => {
    // A JSON-read value has no type, so the check is at run time too.
    const parsed: unknown = JSON.parse("true");
    expect(() => pageIdOf(parsed as number)).toThrow(/PageId/);
  });

  test("shaOf refuses a value that is not a digest", () => {
    expect(() => shaOf("zz")).toThrow(/malformedSha/);
    expect(malformedSha("zz")).toBe("zz");
    expect(shaOf("a".repeat(64))).toBe("a".repeat(64));
  });

  test("every registry test helper is exported", () => {
    const exported = helpers as Record<string, unknown>;
    const declared = webBrands();
    const testHelpers: Record<string, string> = registry.testHelpers;
    const wanted = Object.entries(testHelpers)
      .filter(([brand]) => declared.has(brand))
      .map(([, stem]) => `${stem}Of`);
    expect(wanted).toContain("parkedTitleOf");
    for (const name of wanted) expect(typeof exported[name], name).toBe("function");
    const malformed: Record<string, string> = registry.malformed;
    for (const stem of Object.values(malformed)) {
      const name = `malformed${capitalised(stem)}`;
      expect(typeof exported[name], name).toBe("function");
    }
  });
});
