// pattern: Functional Core
// Turns the server's OpenAPI document into src/api/types.d.ts text. Every
// schema generates as stock openapi-typescript output except one carrying
// an `x-brand` marker (added by the server's `brand()`), which becomes a
// reference to the hand-written brand of the same name in src/api/brands.ts.
// A marker reached through a $ref stays a ref: only the component the
// marker sits on is branded. A marker under `propertyNames` (a dict keyed
// by a branded NewType) is not branded: openapi-typescript ignores
// propertyNames, so the key stays `string`. File I/O lives in genTypes.mjs.
import openapiTS, { astToString } from "openapi-typescript";
import ts from "typescript";

export const BRANDS_IMPORT = 'import type * as Brands from "./brands";';

const BRAND_NAME_RE = /^[A-Z][A-Za-z0-9]*$/;
const BRANDABLE_TYPES = new Set(["string", "integer"]);
const UNBRANDABLE_KEYWORDS = ["nullable", "enum", "const"];

/** Throws unless the marker on `schemaObject` is an identifier on a schema
 * whose `type` is "string" or "integer" and that has no `nullable`, `enum`
 * or `const`. Those keywords would be dropped beside a brand, or would drop
 * the brand, depending on where openapi-typescript meets the schema. */
function checkMarker(schemaObject) {
  const name = schemaObject["x-brand"];
  if (typeof name !== "string" || !BRAND_NAME_RE.test(name)) {
    throw new Error(`x-brand ${JSON.stringify(name)}: not a brand identifier`);
  }
  if (!BRANDABLE_TYPES.has(schemaObject.type)) {
    throw new Error(
      `x-brand ${name}: only a string or integer schema can be branded, ` +
      `not ${JSON.stringify(schemaObject.type)}`);
  }
  for (const key of UNBRANDABLE_KEYWORDS) {
    if (key in schemaObject) {
      throw new Error(`x-brand ${name}: a branded schema cannot carry ${key}`);
    }
  }
  return name;
}

/** Checks every marker in `node` up front. openapi-typescript calls
 * `transform` only on some schemas (not on an enum or const branch, nor on
 * a schema without a type), so a check inside the hook alone would miss a
 * marker it never sees. propertyNames subtrees are skipped (see header). */
export function checkBrandMarkers(node) {
  if (Array.isArray(node)) {
    node.forEach(checkBrandMarkers);
  } else if (node !== null && typeof node === "object") {
    if ("x-brand" in node) checkMarker(node);
    for (const [key, child] of Object.entries(node)) {
      if (key !== "propertyNames") checkBrandMarkers(child);
    }
  }
}

/** openapi-typescript `transform` hook: `Brands.<name>` for a schema with an
 * `x-brand` marker, undefined (stock output) otherwise. */
export function brandTransform(schemaObject) {
  if (schemaObject["x-brand"] === undefined) return undefined;
  const name = checkMarker(schemaObject);
  return ts.factory.createTypeReferenceNode(ts.factory.createQualifiedName(
    ts.factory.createIdentifier("Brands"), name));
}

/** The generated declarations for `spec`, starting with the brands import.
 * Rejects on a malformed marker anywhere in `spec`. */
export async function generateTypes(spec) {
  checkBrandMarkers(spec);
  return astToString(await openapiTS(spec, {
    transform: brandTransform,
    inject: BRANDS_IMPORT,
  }));
}
