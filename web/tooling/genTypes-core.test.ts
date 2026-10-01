import { describe, expect, test } from "vitest";
import { BRANDS_IMPORT, generateTypes } from "./genTypes-core.mjs";

// A minimal OpenAPI 3.1 document whose only content is component schemas.
function spec(schemas: Record<string, unknown>) {
  return {
    openapi: "3.1.0",
    info: { title: "t", version: "0" },
    paths: {},
    components: { schemas },
  };
}

function withProperty(p: unknown) {
  return spec({ T: { type: "object", properties: { p }, required: ["p"] } });
}

describe("generateTypes", () => {
  test("brands a marked string", async () => {
    const out = await generateTypes(
      withProperty({ type: "string", "x-brand": "Sha256Hex" }));
    expect(out.startsWith(BRANDS_IMPORT)).toBe(true);
    expect(out).toContain("p: Brands.Sha256Hex;");
  });

  test("brands the non-null branch of a nullable", async () => {
    const out = await generateTypes(withProperty({
      anyOf: [{ type: "string", "x-brand": "Sha256Hex" }, { type: "null" }],
    }));
    expect(out).toContain("p: Brands.Sha256Hex | null;");
  });

  test("brands list items", async () => {
    const out = await generateTypes(withProperty({
      type: "array", items: { type: "integer", "x-brand": "PageId" },
    }));
    expect(out).toContain("p: Brands.PageId[];");
  });

  test("leaves unmarked schemas alone", async () => {
    const out = await generateTypes(withProperty({ type: "string" }));
    expect(out).toContain("p: string;");
    expect(out).not.toMatch(/Brands\./);
  });

  test("a $ref to a marked component stays a ref", async () => {
    const out = await generateTypes(spec({
      H: { type: "string", "x-brand": "Sha256Hex" },
      T: {
        type: "object",
        properties: { p: { $ref: "#/components/schemas/H" } },
        required: ["p"],
      },
    }));
    expect(out).toContain('p: components["schemas"]["H"];');
    expect(out).toContain("H: Brands.Sha256Hex;");
  });

  test("rejects a malformed marker", async () => {
    await expect(generateTypes(
      withProperty({ type: "string", "x-brand": "not ok" })))
      .rejects.toThrow(/x-brand/);
    await expect(generateTypes(
      withProperty({ type: "boolean", "x-brand": "Flag" })))
      .rejects.toThrow(/x-brand/);
  });
});
