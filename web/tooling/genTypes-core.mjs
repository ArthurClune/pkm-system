// pattern: Functional Core
// Turns the server's OpenAPI document into src/api/types.d.ts text. Every
// schema generates as stock openapi-typescript output except one carrying
// an `x-brand` marker (added by the server's `brand()`), which becomes a
// reference to the hand-written brand of the same name in src/api/brands.ts.
// A marker reached through a $ref stays a ref: only the component the
// marker sits on is branded. File I/O lives in genTypes.mjs.
import openapiTS, { astToString } from "openapi-typescript";
import ts from "typescript";

export const BRANDS_IMPORT = 'import type * as Brands from "./brands";';

const BRAND_NAME_RE = /^[A-Z][A-Za-z0-9]*$/;
const BRANDABLE_TYPES = new Set(["string", "integer"]);

/** openapi-typescript `transform` hook: `Brands.<name>` for a schema with an
 * `x-brand` marker, undefined (stock output) otherwise. Throws on a marker
 * that isn't an identifier or sits on a type a brand can't narrow, so a
 * malformed marker can never generate silently. */
export function brandTransform(schemaObject) {
  const name = schemaObject["x-brand"];
  if (name === undefined) return undefined;
  if (typeof name !== "string" || !BRAND_NAME_RE.test(name)) {
    throw new Error(`x-brand ${JSON.stringify(name)}: not a brand identifier`);
  }
  if (!BRANDABLE_TYPES.has(schemaObject.type)) {
    throw new Error(
      `x-brand ${name}: only a string or integer schema can be branded, ` +
      `not ${JSON.stringify(schemaObject.type)}`);
  }
  return ts.factory.createTypeReferenceNode(ts.factory.createQualifiedName(
    ts.factory.createIdentifier("Brands"), name));
}

/** The generated declarations for `spec`, starting with the brands import. */
export async function generateTypes(spec) {
  return astToString(await openapiTS(spec, {
    transform: brandTransform,
    inject: BRANDS_IMPORT,
  }));
}
