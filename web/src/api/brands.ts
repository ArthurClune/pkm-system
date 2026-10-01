// The one place a web brand is defined. A server NewType tagged with
// `brand()` reaches src/api/types.d.ts as `Brands.<Name>`, a reference to
// the export of the same name here; a marked name this file doesn't export
// fails tsc, and the fix is to add its definition.
//
// A brand is its base type intersected with a literal `__brand`. A subtype
// brand adds a second key instead of a second `__brand`, because two
// different `__brand` literals intersect to `never`:
//
//   export type NormalizedTitle = string & { readonly __brand: "NormalizedTitle" };
//   export type CanonicalTitle = NormalizedTitle & { readonly __canonical: true };
//
// A CanonicalTitle then passes wherever a NormalizedTitle is expected, and
// not the reverse.

// A sha256 hex digest, distinct from a plain string so a text can never
// be passed where a hash belongs. Minted only by `sha256Hex` in
// replica/sha256.ts (and its server twin `text_hash`); a test literal
// standing in for a hash casts `as Sha256Hex`.
export type Sha256Hex = string & { readonly __brand: "Sha256Hex" };
