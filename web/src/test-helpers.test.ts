import { describe, expect, test } from "vitest";
import registry from "../tooling/brandRegistry.gen.json";
import * as helpers from "./test-helpers";
import {
  malformedCanonicalTitle, malformedSeq, malformedSha, malformedUid, pageIdOf, seqOf, shaOf, uidOf,
} from "./test-helpers";

// Every web source file but the tests, to find the brands the web declares:
// those in api/brands.ts and the web-only ones declared beside their code.
const sources = import.meta.glob<string>(
  ["./**/*.{ts,tsx}", "!./**/*.test.{ts,tsx}", "!./**/*.gen.ts"],
  { query: "?raw", import: "default", eager: true },
);

// Brand -> its declared base: `string & { __brand }`, `number & { __brand }`,
// or a subtype brand's parent (`NormalizedTitle & { __canonical }`).
function webBrands(): Map<string, "string" | "number"> {
  const parents = new Map<string, string>();
  for (const text of Object.values(sources)) {
    for (const m of text.matchAll(/type (\w+) =\s*(\w+) & \{ readonly __(?:brand|canonical)\b/g)) {
      parents.set(m[1], m[2]);
    }
  }
  const baseOf = (brand: string): "string" | "number" | undefined => {
    const parent = parents.get(brand);
    if (parent === "string" || parent === "number") return parent;
    return parent === undefined ? undefined : baseOf(parent);
  };
  const found = new Map<string, "string" | "number">();
  for (const brand of parents.keys()) {
    const base = baseOf(brand);
    if (base !== undefined) found.set(brand, base);
  }
  return found;
}

// A value of each shaped brand's pattern; any other brand takes any value
// of its base.
const VALID: { readonly [brand: string]: string } = {
  BlockUid: "tuid-a",
  Sha256Hex: "a".repeat(64),
};

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

  test("malformedSeq returns a non-integer unchecked where seqOf refuses it", () => {
    expect(() => seqOf(Number.NaN)).toThrow(/SyncSeq/);
    expect(Number.isNaN(malformedSeq(Number.NaN))).toBe(true);
  });

  test("malformedUid and malformedCanonicalTitle return null unchecked", () => {
    expect(malformedUid(null)).toBeNull();
    expect(malformedCanonicalTitle(null)).toBeNull();
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

  test("each helper checks its own brand's base", () => {
    const exported = helpers as Record<string, unknown>;
    const testHelpers: Record<string, string> = registry.testHelpers;
    const declared = webBrands();
    expect(declared.get("CanonicalTitle")).toBe("string");
    expect(declared.get("PendingRowId")).toBe("number");
    for (const [brand, base] of declared) {
      const stem = testHelpers[brand];
      if (stem === undefined) continue;
      const helper = exported[`${stem}Of`] as (value: unknown) => unknown;
      const valid = base === "number" ? 7 : VALID[brand] ?? "value-1";
      expect(helper(valid), brand).toBe(valid);
      const other = base === "number" ? "7" : 7;
      expect(() => helper(other), brand).toThrow(new RegExp(`^${brand} takes`));
    }
  });
});
