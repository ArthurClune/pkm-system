// pattern: Imperative Shell
// ESLint rules that keep brands honest on the web, the twin of the server's
// brand rules (docs/architecture/enforced-checks.md#brand-rules):
//   * brands/name-carries-brand: a parameter, property signature or class
//     property whose name means a brand (uid, pageId, sha ...) must be
//     declared with exactly that brand (or null, or an array of it).
//   * brands/no-brand-assertion: `as`/`<T>` toward a type that contains a
//     brand (directly or through a type parameter's constraint), a type
//     predicate (`x is B`), an overload signature returning a brand its
//     implementation does not, and a `declare`d value or function returning
//     one are reported outside the brand's mint sites. A declaration is
//     ambient when `declare` stands on it or on an ancestor (`declare
//     global`, `declare namespace`, `declare class`) or the file is a
//     declaration file. An interface merged with a class, or with a lib or
//     dependency declaration, mints what its added members carry. A function
//     or constructor type holds what it returns, so asserting to one mints
//     through the return. An ambient function, field or variable, or a value
//     that returns `any` (`JSON.parse`) where a function type with a generic
//     return is wanted, launders: nothing the checker reads backs it. An
//     assertion reports whatever its operand: an upcast is written as an
//     annotated declaration
//     (`const ys: readonly BlockUid[] = xs`). A predicate mints only what
//     its narrowing adds to the parameter's declared type, and an overload
//     what its return adds over the implementation's, compared position by
//     position. An assertion, predicate or overload return toward `never`,
//     toward a type parameter a caller can instantiate with a brand its
//     constraint lacks (`T`, `T extends string`, `K extends "a"`), or
//     toward `keyof T`, whose keys the caller picks (`keyof Record<BlockUid,
//     1>`), launders any value, also inside `T[]`, `{ v: T }`, `Promise<T>`
//     ..., and is allowed only on a `brand: untrusted -- <reason>` line in
//     an opt-out file. An opt-out covers one site, the leftmost needing one
//     on its line or on the line below a comment standing alone; one that
//     covers none is reported.
//   * brands/no-brand-bypass: `Reflect.apply`, and a brand-named field
//     written through `Object.assign` or `Object.defineProperty`, which skip
//     the checks the two rules above rely on tsc to raise.
//   * brands/select-keys-literal: the keys argument of `ReplicaDb.select` is
//     an array literal of string literals, or an array or tuple whose
//     element type is a type parameter inside a method or property named
//     `select` (a wrapper passing its generic keys through). Any other
//     array could widen K to every column. Not a brand rule; it lives here
//     as the repo's type-aware rule home.
//   * brands/ts-expect-error-in-probe: a `@ts-expect-error` comment sits in
//     the body of a function expression or arrow passed directly to the
//     `typeProbe` imported from the test helpers, which never calls it, so a
//     suppression cannot carry an off-type value into code that runs. A
//     value a test must feed a runtime guard is `offType<T>(v)` from the
//     same module. Not a brand rule either.
// The brand rules read tooling/brandRegistry.gen.json, generated from the
// server's brand registry, and all apply to tests as they do to product code.
// The test mint module (`testMintSites`) is a mint site for every brand, and
// its exported `offType` alone may assert to a type parameter, which
// launders anywhere else. An `offType<T>(...)` call whose T is a brand (or a
// union, array, Set, Map key or index key of one) is reported in
// `no-brand-assertion`: a bad brand is forged with a `malformed*` helper. A
// brand nested in an object property does not count, but the argument's
// brand-named properties, nested to a fixed depth, must already be the brand.
// In test code (`*.test.*` and the registry's `testCode` paths) a report names
// the module's checked helper (`uidOf`) instead of the product remedy.
// `satisfies` and non-null `!` are not assertions toward a brand and are left
// alone.
import { readFileSync } from "node:fs";
import { dirname, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const toolingDir = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = dirname(dirname(toolingDir));
const registry = JSON.parse(
  readFileSync(`${toolingDir}/brandRegistry.gen.json`, "utf8"),
);

// A registry path: a trailing "/" is a directory prefix, otherwise a glob
// where `**/` is zero or more directories, a bare `**` crosses directories
// and `*` does not (the server lint's `_glob_to_regex` translation).
function pathMatcher(pattern) {
  if (pattern.endsWith("/")) return (p) => p.startsWith(pattern);
  const body = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\//g, "\u0001")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0001/g, "(?:.*/)?")
    .replace(/\u0000/g, ".*");
  const re = new RegExp(`^${body}$`);
  return (p) => re.test(p);
}

const testMintSites = registry.testMintSites.map(pathMatcher);
const testCode = registry.testCode.map(pathMatcher);
const optOutFiles = registry.optOutFiles.map(pathMatcher);
const mintSites = new Map(
  Object.entries(registry.mintSites).map(
    ([brand, paths]) => [brand, paths.map(pathMatcher)],
  ),
);

// A repo-relative posix path; ESLint hands either an absolute path or one
// relative to the web root.
function repoPath(filename) {
  const rel = relative(repoRoot, filename);
  return rel.split(sep).join("/");
}

const TEST_FILE = /\.test\.[cm]?[jt]sx?$/;

// A test by name, or by location in the registry's `testCode`.
function isTestCode(path) {
  return TEST_FILE.test(path) || testCode.some((m) => m(path));
}

// The web's test files as flat-config globs, relative to the web root, for
// the config block that lets tests import the test mint module.
const WEB_PREFIX = "web/";
const testFileGlobs = [
  "**/*.test.{ts,tsx}",
  ...registry.testCode
    .filter((p) => p.startsWith(WEB_PREFIX))
    .map((p) => p.slice(WEB_PREFIX.length))
    .map((p) => (p.endsWith("/") ? `${p}**` : p)),
];

const SET_TYPES = new Set(["Set", "ReadonlySet"]);
const MAP_TYPES = new Set(["Map", "ReadonlyMap"]);
// The subtype chain of api/brands.ts, most derived first: [key, brand].
const SUBTYPES = [
  ["__canonical", "CanonicalTitle"],
  ["__normalized", "NormalizedTitle"],
];
// The `__brand` brand every subtype in the chain sits on.
const SUBTYPE_ROOT = "RawTitle";
const BRAND_TAGS = new Set(["__brand", ...SUBTYPES.map(([key]) => key)]);

const SIGNATURE_KINDS = [ts.SignatureKind.Call, ts.SignatureKind.Construct];

// A type declared only in the TypeScript lib or a dependency.
function isForeign(type) {
  const decls = type.symbol?.declarations ?? [];
  return decls.length > 0 && decls.every((d) => {
    const f = d.getSourceFile();
    return f.hasNoDefaultLib || f.isDeclarationFile
      && /node_modules|typescript\/lib/.test(f.fileName);
  });
}

// The brand names a type carries: every `__brand` property whose type is a
// string literal, found through unions, intersections, type arguments (array,
// tuple, Set, Promise ...) and object properties. Properties of library and
// dependency types are not walked: no brand lives there and they are big.
function brandsOf(checker, type) {
  const found = new Set();
  const seen = new Set();
  const walk = (t) => {
    if (seen.has(t)) return;
    seen.add(t);
    // A type parameter, `Row[K]` or a conditional type holds what its
    // constraint holds.
    if (t.flags & (ts.TypeFlags.TypeParameter | ts.TypeFlags.IndexedAccess
      | ts.TypeFlags.Conditional | ts.TypeFlags.Substitution)) {
      const constraint = checker.getBaseConstraintOfType(t);
      if (constraint && constraint !== t) walk(constraint);
      return;
    }
    if (t.isUnionOrIntersection()) {
      // A subtype brand adds its own key to its parent's brand
      // (api/brands.ts), so the intersection names the subtype, which has
      // its own mint sites, and drops every ancestor brand.
      const subtype = t.isIntersection()
        ? SUBTYPES.find(([key]) => t.types.some((m) => m.getProperty(key)))
        : undefined;
      if (subtype) {
        const inner = new Set();
        for (const m of t.types) brandsOf(checker, m).forEach((b) => inner.add(b));
        const at = SUBTYPES.indexOf(subtype);
        for (const [, ancestor] of SUBTYPES.slice(at + 1)) inner.delete(ancestor);
        inner.delete(SUBTYPE_ROOT);
        inner.add(subtype[1]);
        inner.forEach((b) => found.add(b));
        return;
      }
      t.types.forEach(walk);
      return;
    }
    const brand = t.getProperty("__brand");
    if (brand) {
      const bt = checker.getTypeOfSymbol(brand);
      if (bt.isStringLiteral()) found.add(bt.value);
    }
    if (t.flags & ts.TypeFlags.Object) {
      if (checker.isArrayType(t) || checker.isTupleType(t)
        || t.objectFlags & ts.ObjectFlags.Reference) {
        checker.getTypeArguments(t).forEach(walk);
      }
      const foreign = isForeign(t);
      // A guard type (`type Guard<T> = (v: string) => v is T`) carries its
      // brand in the predicate of its call signature, and a function or
      // constructor type in what it returns.
      if (!foreign) {
        for (const kind of SIGNATURE_KINDS) {
          for (const sig of checker.getSignaturesOfType(t, kind)) {
            const predicate = checker.getTypePredicateOfSignature(sig);
            if (predicate?.type) walk(predicate.type);
            walk(checker.getReturnTypeOfSignature(sig));
          }
        }
      }
      // A lib mapped type (Partial, Pick, Record ...) takes its properties
      // from the caller's type argument, so it is always walked.
      const mapped = (t.objectFlags & ts.ObjectFlags.Mapped) !== 0;
      if (mapped && t.getProperties().length === 0
        && checker.getIndexInfosOfType(t).length === 0) {
        // A mapped type over a type parameter (`Pick<Row, K>`) has no
        // members until instantiated: any key may be picked, so it holds
        // every brand of what it maps over.
        t.aliasTypeArguments?.forEach(walk);
        const decl = t.symbol?.declarations?.find(ts.isMappedTypeNode);
        if (decl?.type && checker.getTypeFromTypeNode(decl) === t) {
          walk(checker.getTypeFromTypeNode(decl.type));
        }
      }
      else if (!foreign || mapped) {
        for (const prop of t.getProperties()) {
          walk(checker.getTypeOfSymbol(prop));
        }
        // `Record<BlockUid, X>` carries the brand in its key, not its value.
        for (const info of checker.getIndexInfosOfType(t)) {
          walk(info.keyType);
          walk(info.type);
        }
      }
      else t.aliasTypeArguments?.forEach(walk);
    }
  };
  walk(type);
  return found;
}

const UNIT = ts.TypeFlags.Unit | ts.TypeFlags.Void;
const isUnit = (t) => t.isUnion() ? t.types.every(isUnit) : (t.flags & UNIT) !== 0;
const isObjectish = (t) =>
  (t.flags & (ts.TypeFlags.Object | ts.TypeFlags.NonPrimitive)) !== 0;
const isNullish = (t) => (t.flags
  & (ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void)) !== 0;

const STRINGISH = ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike;

// A type parameter launders when a caller can instantiate it with a brand
// its constraint does not carry. A brand is a string or a number intersected
// with a literal `__brand` (api/brands.ts), so that is: no constraint, any or
// unknown, a member that admits all strings or numbers, any object type (an
// instantiation may add a branded property, so `T extends { uid: BlockUid }`
// launders `text: Sha256Hex` too), or, where the parameter stands for a
// value, a literal or template member (`K extends "a"` admits
// `BlockUid & "a"`). A key position (`Pick<Columns, K>`, a mapped type's
// keys) never yields a value, so a literal there does not launder. A member
// that is itself a brand (`T extends BlockUid | PageId`) does not launder:
// the mint-site check judges it.
function laundersParam(checker, param, asValue) {
  const constraint = checker.getBaseConstraintOfType(param);
  if (constraint === undefined || constraint === param) return true;
  const members = constraint.isUnion() ? constraint.types : [constraint];
  return members.some((m) => {
    if (m.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return true;
    if (isObjectish(m)) return true;
    if (cachedBrands(checker, m).size > 0) return false;
    if (checker.isTypeAssignableTo(checker.getStringType(), m)
      || checker.isTypeAssignableTo(checker.getNumberType(), m)) return true;
    const parts = m.isIntersection() ? m.types : [m];
    return asValue && parts.some((t) => (t.flags & STRINGISH) !== 0);
  });
}

// Whether `param` occurs in `type`, through unions, intersections, type
// arguments, alias arguments, properties, index signatures and the
// parameters and returns of signatures.
function mentions(checker, type, param, seen = new Set()) {
  if (seen.has(type)) return false;
  seen.add(type);
  if (type === param) return true;
  const go = (t) => mentions(checker, t, param, seen);
  if (type.aliasTypeArguments?.some(go)) return true;
  if (type.flags & ts.TypeFlags.IndexedAccess) {
    return go(type.objectType) || go(type.indexType);
  }
  if (type.flags & ts.TypeFlags.Index) return go(type.type);
  if (type.flags & ts.TypeFlags.Conditional) {
    return go(type.checkType) || go(type.extendsType);
  }
  if (type.isUnionOrIntersection()) return type.types.some(go);
  if (!(type.flags & ts.TypeFlags.Object)) return false;
  if ((type.objectFlags & ts.ObjectFlags.Reference)
    && checker.getTypeArguments(type).some(go)) return true;
  if (isForeign(type)) return false;
  return type.getProperties().some((p) => go(checker.getTypeOfSymbol(p)))
    || checker.getIndexInfosOfType(type).some((i) => go(i.keyType) || go(i.type))
    || SIGNATURE_KINDS.some((kind) => checker.getSignaturesOfType(type, kind)
      .some((sig) => sig.getParameters()
        .some((a) => go(checker.getTypeOfSymbol(a)))
        || go(checker.getReturnTypeOfSignature(sig))));
}

// An assertion toward this type accepts any value: `never`, or a laundering
// type parameter anywhere in it (`T`, `T[]`, `{ v: T }`, `Promise<T>`,
// `T & {}`, `T[K]`, `Partial<T>`, `ReturnType<F>` ...), walked like
// brandsOf walks brands, and through the arguments of any type alias. Alias
// arguments, index keys and a mapped type's keys are walked as keys; the
// structure behind an alias is walked as values.
function launders(checker, type, neverLaunders = true) {
  const seen = [new Set(), new Set()];
  // The type parameters of a function type in the target that a parameter
  // of that function mentions (`transaction<T>(fn: () => T): T`): its caller
  // ties them to a value they passed. Inside a return, `never` is a function
  // that does not come back.
  const tied = new Set();
  let inReturn = 0;
  const walk = (t, asValue = true) => {
    const visited = seen[asValue ? 1 : 0];
    if (visited.has(t)) return false;
    visited.add(t);
    const key = (u) => walk(u, false);
    if (t.flags & ts.TypeFlags.Never) return neverLaunders && inReturn === 0;
    if (t.flags & ts.TypeFlags.TypeParameter) {
      return !tied.has(t) && laundersParam(checker, t, asValue);
    }
    // `keyof T` (or `keyof T[K]`) stays unresolved only while its keys come
    // from a type parameter, and a caller picks them: `keyof
    // Record<BlockUid, 1>` is a BlockUid. A concrete `keyof Row` resolves to
    // its literal keys and never reaches here.
    if (t.flags & ts.TypeFlags.Index) return true;
    if (t.aliasTypeArguments?.some(key)) return true;
    if (t.flags & ts.TypeFlags.IndexedAccess) {
      return walk(t.objectType) || key(t.indexType);
    }
    if (t.flags & ts.TypeFlags.Conditional) {
      const constraint = checker.getBaseConstraintOfType(t);
      return walk(t.checkType, asValue)
        || constraint !== undefined && walk(constraint, asValue);
    }
    if (t.isUnionOrIntersection()) return t.types.some((m) => walk(m, asValue));
    if (!(t.flags & ts.TypeFlags.Object)) return false;
    if (checker.isArrayType(t) || checker.isTupleType(t)
      || t.objectFlags & ts.ObjectFlags.Reference) {
      if (checker.getTypeArguments(t).some((a) => walk(a))) return true;
    }
    const mapped = (t.objectFlags & ts.ObjectFlags.Mapped) !== 0;
    if (isForeign(t) && !mapped) return false;
    const props = t.getProperties();
    const infos = checker.getIndexInfosOfType(t);
    if (mapped && props.length === 0 && infos.length === 0) {
      // A mapped type written over a type parameter (`{ [K in keyof T]:
      // T[K] }`) has no members until instantiated: judge what it is written
      // over. An instantiation (`Pick<Columns, K>`) differs from its
      // declaration's type, which names the alias's own parameters, and is
      // judged by its alias arguments above.
      const decl = t.symbol?.declarations?.find(ts.isMappedTypeNode);
      if (!decl || checker.getTypeFromTypeNode(decl) !== t) return false;
      const keys = decl.typeParameter.constraint;
      return keys !== undefined && key(checker.getTypeFromTypeNode(keys))
        || decl.type !== undefined && walk(checker.getTypeFromTypeNode(decl.type));
    }
    return props.some((p) => walk(checker.getTypeOfSymbol(p)))
      || infos.some((i) => key(i.keyType) || walk(i.type))
      || SIGNATURE_KINDS.some((kind) => checker.getSignaturesOfType(t, kind)
        .some(walkReturn));
  };
  const walkReturn = (sig) => {
    const own = (sig.typeParameters ?? []).filter((p) => sig.getParameters()
      .some((a) => mentions(checker, checker.getTypeOfSymbol(a), p)));
    own.forEach((p) => tied.add(p));
    inReturn++;
    const found = walk(checker.getReturnTypeOfSignature(sig));
    inReturn--;
    own.forEach((p) => tied.delete(p));
    return found;
  };
  return walk(type);
}

// The brand literal a type itself carries (not one nested inside it): the
// most derived subtype key's brand when it holds one (SUBTYPES), else its
// `__brand` literal.
function ownBrand(checker, type) {
  const subtype = SUBTYPES.find(([key]) => type.getProperty(key));
  if (subtype) return subtype[1];
  const brand = type.getProperty("__brand");
  if (!brand) return null;
  const bt = checker.getTypeOfSymbol(brand);
  return bt.isStringLiteral() ? bt.value : null;
}

// The brands a type is, not merely holds: its own brand, or that of the
// members of a union, the elements of an array or tuple, a Set's element, a
// Map's or index signature's key. A brand nested in an object's property is
// not counted, so a junk union of object shapes that mention ids is not a
// forged brand.
function shallowBrands(checker, type) {
  const found = new Set();
  const walk = (t) => {
    if (t.isUnion()) return t.types.forEach(walk);
    const own = ownBrand(checker, t);
    if (own !== null) return found.add(own);
    if (checker.isArrayType(t) || checker.isTupleType(t)) {
      return checker.getTypeArguments(t).forEach(walk);
    }
    const name = t.symbol?.name;
    if (SET_TYPES.has(name) || MAP_TYPES.has(name)) {
      const [first] = checker.getTypeArguments(t);
      if (first !== undefined) walk(first);
      return undefined;
    }
    if (t.getProperties().length === 0) {
      checker.getIndexInfosOfType(t).forEach((i) => walk(i.keyType));
    }
    return undefined;
  };
  walk(type);
  return found;
}

// Rule 1's check: the declared type is one of `wanted`, null/undefined, or an
// array/tuple/Set of those, a Map or index-signature type keyed by one, or a
// union of such. A union with the base type, or a brand merely nested in an
// object, does not pass.
function declaresBrand(checker, type, wanted) {
  if (type.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)) return true;
  if (type.isUnion()) {
    return type.types.every((m) => declaresBrand(checker, m, wanted));
  }
  const own = ownBrand(checker, type);
  if (own !== null) return wanted.includes(own);
  if (checker.isArrayType(type) || checker.isTupleType(type)) {
    const elems = checker.getTypeArguments(type);
    return elems.length > 0
      && elems.every((e) => declaresBrand(checker, e, wanted));
  }
  const name = type.symbol?.name;
  if (SET_TYPES.has(name) || MAP_TYPES.has(name)) {
    // A Set's element, or a Map's key, is the id; a Map's value is not.
    const [first] = checker.getTypeArguments(type);
    return first !== undefined && declaresBrand(checker, first, wanted);
  }
  if (type.getProperties().length === 0) {
    // `Record<BlockUid, X>`: an index signature keyed by the brand.
    const infos = checker.getIndexInfosOfType(type);
    return infos.length > 0
      && infos.every((i) => declaresBrand(checker, i.keyType, wanted));
  }
  return false;
}

// Whether a value could have both types. Conservative: only what TypeScript
// itself treats as disjoint is -- two primitives neither of which fits the
// other (`null` and `BlockUid`, `string` and `number`), null against an
// object, and two objects whose shared property holds unit types with no
// value in common (a discriminant: `{ op: "insert" }` and `{ op: "move" }`,
// or two `__brand` literals).
function overlaps(checker, a, b) {
  const any = ts.TypeFlags.Any | ts.TypeFlags.Unknown;
  if (a.flags & ts.TypeFlags.TypeParameter) {
    a = checker.getBaseConstraintOfType(a) ?? checker.getUnknownType();
  }
  if (b.flags & ts.TypeFlags.TypeParameter) {
    b = checker.getBaseConstraintOfType(b) ?? checker.getUnknownType();
  }
  if ((a.flags | b.flags) & any) return true;
  if (a.isUnion()) return a.types.some((m) => overlaps(checker, m, b));
  if (b.isUnion()) return b.types.some((m) => overlaps(checker, a, m));
  if (checker.isTypeAssignableTo(a, b) || checker.isTypeAssignableTo(b, a)) {
    return true;
  }
  if (a.isIntersection()) return a.types.every((m) => overlaps(checker, m, b));
  if (b.isIntersection()) return b.types.every((m) => overlaps(checker, a, m));
  if (isObjectish(a) && isObjectish(b)) {
    return !b.getProperties().some((pb) => {
      const pa = a.getProperty(pb.name);
      if (!pa) return false;
      const ta = checker.getTypeOfSymbol(pa);
      const tb = checker.getTypeOfSymbol(pb);
      return isUnit(ta) && isUnit(tb) && !overlaps(checker, ta, tb);
    });
  }
  // A string or number meets an object type only when every member of the
  // object is one of its apparent members (`length`) or a brand's phantom
  // tag; null never does.
  if (isObjectish(a) !== isObjectish(b)) {
    const [obj, prim] = isObjectish(a) ? [a, b] : [b, a];
    if (isNullish(prim) || obj.flags & ts.TypeFlags.NonPrimitive) return false;
    if (checker.getSignaturesOfType(obj, ts.SignatureKind.Call).length > 0) {
      return false;
    }
    // A string's characters sit behind a number index, not properties.
    const apparent = checker.getApparentType(prim);
    const indexed = checker.getIndexInfoOfType(apparent, ts.IndexKind.Number);
    const isNumeric = (name) => String(Number(name)) === name;
    return obj.getProperties().every((p) => BRAND_TAGS.has(p.name)
      || apparent.getProperty(p.name) || indexed && isNumeric(p.name));
  }
  return false;
}

// The lib or own references a reference type extends, directly or through
// its own bases, with each base's type arguments written in terms of the
// reference's own: `Index<BlockUid, V>` extending `Map<K, V>` gives `Map`
// with [BlockUid, V]. A base whose arguments are not plain type parameters
// of the type extending it is skipped, and so is what lies beyond it.
function instantiatedBases(checker, type) {
  if (!(type.objectFlags & ts.ObjectFlags.Reference)) return [];
  const bases = [];
  const seen = new Set();
  const walk = (target, args) => {
    if (seen.has(target)) return;
    seen.add(target);
    const params = target.typeParameters ?? [];
    for (const base of checker.getBaseTypes(target) ?? []) {
      if (!(base.objectFlags & ts.ObjectFlags.Reference)) continue;
      const mapped = checker.getTypeArguments(base).map((a) => {
        const i = params.indexOf(a);
        return i >= 0 ? args[i] : undefined;
      });
      if (!mapped.every((a) => a !== undefined)) continue;
      bases.push({ target: base.target, args: mapped });
      walk(base.target, mapped);
    }
  };
  walk(type.target, checker.getTypeArguments(type));
  return bases;
}

// What an array-like or iterable type holds: its number index type, or the
// first type argument of a reference (`Iterable<T>`, `ReadonlySet<T>`).
function elementOf(checker, type) {
  const indexed = checker.getIndexTypeOfType(type, ts.IndexKind.Number);
  if (indexed) return indexed;
  if (!(type.objectFlags & ts.ObjectFlags.Reference)) return undefined;
  return checker.getTypeArguments(type)[0];
}

// Whether `to`, which launders, has a laundering position that the declared
// type `from` does not hold: a predicate `x is T` launders from `x: string`
// or `x: T | string`, whose string can become any T, and not from `x: T |
// null`, whose members are a T already or nothing. Positions are compared
// as `mintedBrands` compares them: a type parameter is held where `from`
// fits it (`T`, `U extends T`), a union of `to` where some member is, an
// intersection where every member is, a generic mapped type (`Partial<T>`)
// where what it maps over is, and an array, reference or object through its
// elements, arguments and properties.
function unbackedLaunder(checker, from, to, seen = new Map()) {
  if (from === to || !cachedLaunders(checker, to)) return false;
  // `any` fits every type parameter and holds none: a guard over
  // `MessageEvent["data"]` narrows a string to any `T`.
  if (from.flags & ts.TypeFlags.Any) return true;
  const unheld = (source, target) =>
    source === undefined ? cachedLaunders(checker, target)
      : unbackedLaunder(checker, source, target, seen);
  if (from.isUnion()) {
    return from.types.some((m) => !isNullish(m)
      && !(m.flags & ts.TypeFlags.Never) && unheld(m, to));
  }
  if (from.isIntersection() && ownBrand(checker, from) === null) {
    return from.types.every((m) => unheld(m, to));
  }
  if (to.isUnion()) {
    // `from` (one member of its own union by now) must fit a member that
    // launders nothing or hold one that does: the `string` of `T | string`
    // fits the `string` of `T | string` and holds nothing of `T | number`,
    // whose `number` is narrowed away before `T` is read.
    return !to.types.some((m) => cachedLaunders(checker, m)
      ? !unheld(from, m) : checker.isTypeAssignableTo(from, m));
  }
  if (to.flags & (ts.TypeFlags.TypeParameter | ts.TypeFlags.Index
    | ts.TypeFlags.IndexedAccess | ts.TypeFlags.Conditional)) {
    return !checker.isTypeAssignableTo(from, to);
  }
  const targets = seen.get(from) ?? new Set();
  if (targets.has(to)) return false;
  seen.set(from, targets.add(to));
  if (to.isIntersection()) return to.types.some((m) => unheld(from, m));
  if (!(to.flags & ts.TypeFlags.Object)) return !checker.isTypeAssignableTo(from, to);
  const isReference = (t) => (t.objectFlags & ts.ObjectFlags.Reference) !== 0;
  if (checker.isArrayType(to) || checker.isTupleType(to)) {
    const fromElements = checker.isTupleType(from) && checker.isTupleType(to)
      ? checker.getTypeArguments(from) : [];
    const element = elementOf(checker, from);
    return checker.getTypeArguments(to).some(
      (t, i) => unheld(fromElements[i] ?? element, t),
    );
  }
  if (isReference(to) && isReference(from)) {
    const fromArgs = checker.getTypeArguments(from);
    const toArgs = checker.getTypeArguments(to);
    const libPair = isForeign(from) && isForeign(to)
      && fromArgs.length === toArgs.length;
    if (from.target === to.target || libPair) {
      return toArgs.some((t, i) => unheld(fromArgs[i], t));
    }
  }
  // A lib type's members are not walked: `unknown` holds nothing of
  // `Promise<T>`, a `Promise<U>` was paired above.
  if (isForeign(to) && !(to.objectFlags & ts.ObjectFlags.Mapped)) {
    return !checker.isTypeAssignableTo(from, to);
  }
  const props = to.getProperties();
  const infos = checker.getIndexInfosOfType(to);
  if (to.objectFlags & ts.ObjectFlags.Mapped && props.length === 0
    && infos.length === 0) {
    // `Partial<T>` over a type parameter has no members until instantiated:
    // it is held where what it maps over is (its alias arguments, or the
    // `T` of `keyof T` written in place), or argument by argument by the
    // same alias (`Partial<T>` over `Partial<U>`).
    if (to.aliasSymbol !== undefined && from.aliasSymbol === to.aliasSymbol) {
      const fromArgs = from.aliasTypeArguments ?? [];
      return (to.aliasTypeArguments ?? []).some((a, i) => unheld(fromArgs[i], a));
    }
    const over = [...(to.aliasTypeArguments ?? [])];
    const decl = to.symbol?.declarations?.find(ts.isMappedTypeNode);
    const keys = decl?.typeParameter.constraint;
    if (keys && checker.getTypeFromTypeNode(decl) === to) {
      const keyType = checker.getTypeFromTypeNode(keys);
      if (keyType.flags & ts.TypeFlags.Index) over.push(keyType.type);
    }
    return over.some((o) => cachedLaunders(checker, o) && unheld(from, o));
  }
  const stringIndex = checker.getIndexTypeOfType(from, ts.IndexKind.String);
  if (props.some((p) => {
    const declared = from.getProperty(p.name);
    return unheld(declared ? checker.getTypeOfSymbol(declared) : stringIndex,
      checker.getTypeOfSymbol(p));
  })) return true;
  const fromInfos = checker.getIndexInfosOfType(from);
  return infos.some((info) => {
    const same = fromInfos.find((i) => checker.isTypeAssignableTo(i.keyType, info.keyType));
    return unheld(same?.type, info.type);
  });
}

// The brands of the properties of `to` that `from` does not declare: what
// width subtyping lets a value of `from` hold there.
function undeclaredBrands(checker, from, to) {
  const found = new Set();
  if (checker.getIndexTypeOfType(from, ts.IndexKind.String)) return found;
  for (const p of to.getProperties()) {
    if (from.getProperty(p.name)) continue;
    cachedBrands(checker, checker.getTypeOfSymbol(p)).forEach((b) => found.add(b));
  }
  return found;
}

// The brands a value typed `from` gains by being believed to be `to` (a
// type predicate's narrowing, an overload's return). Each position of `to`
// is compared with the matching position of `from`: an array or tuple
// element with `from`'s element, a reference's type arguments with those
// of the same generic type or of a lib type of the same arity
// (`ReadonlySet` to `Set`, `PromiseLike` to `Promise`), an object's
// properties and index signatures with `from`'s. A position `from` does not
// declare (an optional property, a tuple element past its length, an index
// signature) mints every brand there: width subtyping lets the value hold
// anything, so `{ a: 1 }` believed to be `{ a: 1; uid?: BlockUid }` gains
// BlockUid. Where no position matches, every brand of `to` is minted: a
// brand elsewhere in `from` does not cover it. Only the members of a `from`
// union that could hold a `to` are compared: `BlockUid | null` narrowed to
// `BlockUid` gains none, `BlockUid | string` gains BlockUid from its string.
function mintedBrands(checker, from, to, seen = new Map()) {
  const minted = new Set();
  const add = (brands) => brands.forEach((b) => minted.add(b));
  const every = () => new Set(cachedBrands(checker, to));
  // What a member `to` lends `from` where `from` cannot be it: the brands of
  // the properties `from` does not declare.
  const lentBy = (source, member) => {
    if (overlaps(checker, source, member)) {
      return mintedBrands(checker, source, member, seen);
    }
    return isObjectish(member) && isObjectish(source)
      ? undeclaredBrands(checker, source, member) : new Set();
  };
  const compare = (source, target) => add(source === undefined
    ? cachedBrands(checker, target) : mintedBrands(checker, source, target, seen));
  if (from === to) return minted;
  if (from.flags & ts.TypeFlags.Any) return every();
  if (from.isUnion()) {
    for (const m of from.types) {
      // A member of both unions gains nothing as itself, and only what the
      // members of `to` that `from` lacks lend it.
      if (to.isUnion() && to.types.includes(m)) {
        for (const t of to.types) {
          if (!from.types.includes(t)) add(lentBy(m, t));
        }
      }
      else if (overlaps(checker, m, to)) add(mintedBrands(checker, m, to, seen));
    }
    return minted;
  }
  // A value of `A & B` is an `A` and a `B`: it gains only what it would
  // gain as each of them.
  if (from.isIntersection() && ownBrand(checker, from) === null) {
    let common;
    for (const m of from.types) {
      const gained = mintedBrands(checker, m, to, seen);
      common = common === undefined
        ? gained : new Set([...common].filter((b) => gained.has(b)));
    }
    return common ?? minted;
  }
  if (to.isUnion()) {
    // A member `from` is gains nothing. Any other member `from` could be is
    // compared, and a member it cannot be (a discriminant rules it out)
    // still lends the union its properties, whether or not `from` is one of
    // the members: `{ k: 1 }` believed to be
    // `{ k: 1 } | { k: 2; uid?: BlockUid }` reads `uid` as a BlockUid. A
    // `from` that could be no member (`null` believed to be `BlockUid |
    // undefined`) gains every brand.
    let overlapping = false;
    for (const m of to.types) {
      if (m === from) overlapping = true;
      else if (overlaps(checker, from, m)) {
        overlapping = true;
        add(mintedBrands(checker, from, m, seen));
      }
      else add(lentBy(from, m));
    }
    return overlapping ? minted : every();
  }
  // A brand or a primitive that `from` fits adds nothing. An object type,
  // or an intersection of them, is compared position by position even where
  // `from` fits it, because a position `from` does not declare fits
  // anything.
  const leaf = ownBrand(checker, to) !== null
    || !isObjectish(to) && !to.isIntersection();
  if (leaf && checker.isTypeAssignableTo(from, to)) return minted;
  if (from.flags & ts.TypeFlags.TypeParameter) {
    const constraint = checker.getBaseConstraintOfType(from);
    return mintedBrands(checker, constraint ?? checker.getUnknownType(), to, seen);
  }
  // A recursive type meets itself again: the first visit judges it.
  const targets = seen.get(from) ?? new Set();
  if (targets.has(to)) return minted;
  seen.set(from, targets.add(to));
  const isReference = (t) => (t.objectFlags & ts.ObjectFlags.Reference) !== 0;
  // An intersection that is not itself a brand (`Set<BlockUid> & { a: 1 }`)
  // mints what any of its members does, each taking its own path.
  if (ownBrand(checker, to) === null && to.isIntersection()) {
    for (const m of to.types) add(mintedBrands(checker, from, m, seen));
    return minted;
  }
  if (checker.isArrayType(to) || checker.isTupleType(to)) {
    const fromElements = checker.isTupleType(from) && checker.isTupleType(to)
      ? checker.getTypeArguments(from) : [];
    const element = elementOf(checker, from);
    checker.getTypeArguments(to).forEach(
      (t, i) => compare(fromElements[i] ?? element, t),
    );
    return minted;
  }
  if (isReference(to) && isReference(from)) {
    const fromArgs = checker.getTypeArguments(from);
    const toArgs = checker.getTypeArguments(to);
    // Two lib references of one arity (`ReadonlySet` and `Set`) hold the
    // same thing at each position; two of our own types need not, and are
    // compared property by property below.
    const libPair = isForeign(from) && isForeign(to)
      && fromArgs.length === toArgs.length;
    if (from.target === to.target || libPair) {
      toArgs.forEach((t, i) => compare(fromArgs[i], t));
      return minted;
    }
  }
  const structural = ownBrand(checker, to) === null && isObjectish(to)
    && (!isForeign(to) || (to.objectFlags & ts.ObjectFlags.Mapped) !== 0);
  if (!structural) return every();
  // A brand of `to` that no compared position holds (the `T` of our own
  // `interface TaggedSet<T> extends Set<T>`, reached only through method
  // signatures) is minted too.
  const accounted = new Set();
  const position = (source, target) => {
    cachedBrands(checker, target).forEach((b) => accounted.add(b));
    compare(source, target);
  };
  // A property `from` does not declare holds what its string index allows,
  // or anything.
  const stringIndex = checker.getIndexTypeOfType(from, ts.IndexKind.String);
  for (const p of to.getProperties()) {
    const declared = from.getProperty(p.name);
    position(declared ? checker.getTypeOfSymbol(declared) : stringIndex,
      checker.getTypeOfSymbol(p));
  }
  // A function or constructor type holds what it returns: compared with the
  // signature at the same place in `from`, or minted outright where `from`
  // has none.
  for (const kind of SIGNATURE_KINDS) {
    const fromSigs = checker.getSignaturesOfType(from, kind);
    checker.getSignaturesOfType(to, kind).forEach((sig, i) => {
      position(fromSigs[i] && checker.getReturnTypeOfSignature(fromSigs[i]),
        checker.getReturnTypeOfSignature(sig));
    });
  }
  // Our own `class Index<K, V> extends Map<K, V>` holds its arguments where
  // its base does, however many classes down: compare them with a `from` of
  // that base's type, or of a lib type of the same arity (`ReadonlyMap`
  // narrowed to an own `Map` subclass).
  if (isReference(from)) {
    const fromArgs = checker.getTypeArguments(from);
    for (const base of instantiatedBases(checker, to)) {
      const libPair = isForeign(from) && isForeign(base.target)
        && base.args.length === fromArgs.length;
      if (base.target === from.target || libPair) {
        base.args.forEach((t, i) => position(fromArgs[i], t));
      }
    }
  }
  const fromInfos = checker.getIndexInfosOfType(from);
  for (const info of checker.getIndexInfosOfType(to)) {
    const keyBrands = cachedBrands(checker, info.keyType);
    keyBrands.forEach((b) => accounted.add(b));
    // A `string` key does not back a `BlockUid` key: every key stored must
    // be one of the target's. A plain target key is backed by the `from`
    // signature its reads hit, which for a string index includes number
    // keys, as TypeScript applies it.
    const applies = (i) => checker.isTypeAssignableTo(info.keyType, i.keyType)
      || (i.keyType.flags & ts.TypeFlags.String) !== 0
        && checker.isTypeAssignableTo(info.keyType, checker.getNumberType());
    const same = fromInfos.find((i) =>
      checker.isTypeAssignableTo(i.keyType, info.keyType)
      || keyBrands.size === 0 && applies(i));
    if (same) position(same.type, info.type);
    else {
      add(keyBrands);
      add(cachedBrands(checker, info.type));
    }
  }
  for (const b of cachedBrands(checker, to)) if (!accounted.has(b)) minted.add(b);
  return minted;
}

function servicesOf(context) {
  const services = context.sourceCode.parserServices;
  if (!services?.program || !services.esTreeNodeToTSNodeMap) {
    throw new Error("brands rules need type information (projectService)");
  }
  return services;
}

// Brand and launder detection are cached per type for the lifetime of a
// program.
const caches = new WeakMap();
function cachedBy(compute, checker, type) {
  let byChecker = caches.get(compute);
  if (!byChecker) caches.set(compute, byChecker = new WeakMap());
  let cache = byChecker.get(checker);
  if (!cache) byChecker.set(checker, cache = new Map());
  if (!cache.has(type)) cache.set(type, compute(checker, type));
  return cache.get(type);
}
const cachedBrands = (checker, type) => cachedBy(brandsOf, checker, type);
const cachedLaunders = (checker, type) => cachedBy(launders, checker, type);
// What a function returns launders unless it is `never`: a function that
// returns `never` never produces a value.
const launderingReturn = (checker, type) => launders(checker, type, false);
const cachedLaunderingReturn = (checker, type) =>
  cachedBy(launderingReturn, checker, type);

const members = (type) => (type.isUnion() ? type.types : [type]);

// Whether a call of this function type lets the caller name what comes back:
// a signature with type parameters of its own whose return launders
// (`<T>(s: string) => T`, `<T>(s: string) => Promise<T[]>`).
function genericReturn(checker, type) {
  return members(type).some((m) =>
    checker.getSignaturesOfType(m, ts.SignatureKind.Call).some((sig) =>
      (sig.typeParameters?.length ?? 0) > 0
      && cachedLaunderingReturn(checker, checker.getReturnTypeOfSignature(sig))));
}

// Whether `any` is the type or sits in a union, intersection or type
// argument of it: what `JSON.parse` returns, which fits any `T`.
function holdsAny(checker, type, seen = new Set()) {
  if (seen.has(type)) return false;
  seen.add(type);
  if (type.flags & ts.TypeFlags.Any) return true;
  if (type.isUnionOrIntersection()) {
    return type.types.some((m) => holdsAny(checker, m, seen));
  }
  return (type.objectFlags & ts.ObjectFlags.Reference) !== 0
    && checker.getTypeArguments(type).some((a) => holdsAny(checker, a, seen));
}

// Whether a value of this type is, or returns, `any` somewhere, so that
// assigning it to `<T>(s: string) => T` is accepted for any `T`.
function anyReturning(checker, type) {
  return holdsAny(checker, type) || members(type).some((m) =>
    checker.getSignaturesOfType(m, ts.SignatureKind.Call).some((sig) =>
      holdsAny(checker, checker.getReturnTypeOfSignature(sig))));
}

// Whether a declaration sits in the TypeScript lib or a dependency.
const inForeignFile = (decl) => {
  const f = decl.getSourceFile();
  return f.hasNoDefaultLib || f.isDeclarationFile
    && /node_modules|typescript\/lib/.test(f.fileName);
};

// "reason" for `// brand: untrusted -- <why>`, "bare" for the marker with no
// reason, null for any other comment.
function optOutKind(comment) {
  if (/^\s*brand: untrusted -- \S/.test(comment.value)) return "reason";
  if (/^\s*brand: untrusted\b/.test(comment.value)) return "bare";
  return null;
}

// An opt-out covers exactly one site: the leftmost site (by line, then
// column) that needs one, on the comment's own line or on the line below a
// comment standing alone. A second site on the line is reported, and so is
// an opt-out that covers none, as the server's `brand-opt-out-unused` does.
// The two brand rules that read opt-outs (`name-carries-brand`,
// `no-brand-assertion`) hand their sites to one ledger per file, which pairs
// them once every rule has finished the traversal, so the order the rules
// walk in cannot change who is covered. A site is `{ line, column, resolve }`
// and `resolve(kind)` reports it given the kind of the comment that covers it
// ("reason", "bare") or null.
const ledgers = new WeakMap();

function joinLedger(context) {
  const { sourceCode } = context;
  let ledger = ledgers.get(sourceCode);
  if (!ledger) {
    ledger = {
      rules: 0,
      sites: [],
      reportUnused: (comment) =>
        context.report({ loc: comment.loc, messageId: "optOutUnused" }),
    };
    ledgers.set(sourceCode, ledger);
  }
  ledger.rules++;
  return {
    site(node, resolve) {
      const { line, column } = node.loc.start;
      ledger.sites.push({ line, column, resolve });
    },
    exit() {
      if (--ledger.rules > 0) return;
      ledgers.delete(sourceCode);
      settleOptOuts(sourceCode, ledger);
    },
  };
}

function settleOptOuts(sourceCode, ledger) {
  const standsAlone = (c) =>
    sourceCode.lines[c.loc.start.line - 1].slice(0, c.loc.start.column)
      .trim() === "";
  const comments = sourceCode.getAllComments()
    .map((comment) => ({ comment, kind: optOutKind(comment) }))
    .filter((o) => o.kind !== null);
  const claimed = new Set();
  const sites = [...ledger.sites].sort(
    (a, b) => a.line - b.line || a.column - b.column);
  for (const site of sites) {
    const cover = comments.find(({ comment: c }) => !claimed.has(c)
      && (c.loc.end.line === site.line
        || c.loc.end.line === site.line - 1 && standsAlone(c)));
    if (cover) claimed.add(cover.comment);
    site.resolve(cover?.kind ?? null);
  }
  for (const { comment } of comments) {
    if (!claimed.has(comment)) ledger.reportUnused(comment);
  }
}

const OPT_OUT_UNUSED =
  "this `// brand: untrusted -- <reason>` covers no site: an opt-out covers "
  + "the leftmost name or assertion on its line, or on the line below it "
  + "when it stands alone, that needs one, so remove it, or give each "
  + "further site its own line and its own opt-out";

// The brand-specific parser, where the web has one.
const MODULES_SHOWN = 3;
const PARSERS = { BlockUid: "parseBlockUid", SyncSeq: "parseSyncSeq" };

const webTestMints = registry.testMintSites
  .filter((p) => p.startsWith(WEB_PREFIX));

// "use uidOf or malformedUid from web/src/test-helpers.ts": the checked
// helper a test mints these brands with, and the forger of a bad value where
// the brand has a shape. Null when a brand has no helper.
function testRemedy(brands) {
  const names = [];
  for (const b of brands) {
    const stem = registry.testHelpers[b];
    if (stem === undefined) return null;
    names.push(`${stem}Of`);
    const bad = registry.malformed[b];
    if (bad !== undefined) {
      names.push(`malformed${bad[0].toUpperCase()}${bad.slice(1)}`);
    }
  }
  return `use ${names.join(" or ")} from ${webTestMints.join(", ")}`;
}

// "parseBlockUid, or mint it in web/src/uid.ts" from the registry's web mint
// modules for these brands; in test code, the test helper.
function remedy(brands, inTest) {
  const forTest = inTest ? testRemedy(brands) : null;
  if (forTest !== null) return forTest;
  const parsers = brands.map((b) => PARSERS[b]).filter(Boolean);
  const modules = [...new Set(brands.flatMap(
    (b) => (registry.mintSites[b] ?? []).filter((p) => p.startsWith("web/")),
  ))];
  const parts = [];
  if (parsers.length) parts.push(`parse it with ${parsers.join(", ")}`);
  if (modules.length) {
    const shown = modules.slice(0, MODULES_SHOWN).join(", ");
    const more = modules.length - MODULES_SHOWN;
    parts.push(`mint it in ${shown}${more > 0 ? ` and ${more} more` : ""}`);
  }
  // No web mint site: the value belongs to where it enters the app, not to a
  // new registry entry here.
  else parts.push("pass it in already branded: this brand has no web mint site");
  return parts.join(", or ");
}

// `BlockUid` or `BlockUid[]`, by whether the name is a plural.
function brandText(name, wanted) {
  const text = wanted.join(" or ");
  return /(uids|ids)$/i.test(name) ? `${text}[]` : text;
}

const nameCarriesBrand = {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      missing:
        "`{{name}}` must be `{{brand}}`: read it from a replica `select` row, "
        + "take it from a generated API type, or {{remedy}}",
      optOut:
        "`{{name}}` must be `{{brand}}`: `brand: untrusted` is allowed only "
        + "in the registry's opt-out files, not here",
      noReason:
        "`{{name}}` is `brand: untrusted` with no reason: add a reason after "
        + "`--` saying what untrusted input is parsed here",
      optOutUnused: OPT_OUT_UNUSED,
    },
  },
  create(context) {
    const path = repoPath(context.filename);
    const inTest = isTestCode(path);
    const { program, esTreeNodeToTSNodeMap } = servicesOf(context);
    const checker = program.getTypeChecker();
    const mayOptOut = optOutFiles.some((m) => m(path));
    const ledger = joinLedger(context);

    const check = (name, anchor, tsNode) => {
      const wanted = registry.names[name];
      if (!wanted) return;
      const type = checker.getTypeAtLocation(tsNode);
      if (declaresBrand(checker, type, wanted)) return;
      const data = {
        name,
        brand: brandText(name, wanted),
        remedy: remedy(wanted, inTest),
      };
      ledger.site(anchor, (optOut) => {
        if (optOut === "reason" && mayOptOut) return;
        let messageId = "missing";
        if (optOut === "reason") messageId = "optOut";
        else if (optOut === "bare" && mayOptOut) messageId = "noReason";
        context.report({ node: anchor, messageId, data });
      });
    };
    const keyName = (member) => {
      const key = member.key;
      if (!key || member.computed) return null;
      if (key.type === "Identifier") return key.name;
      if (key.type === "Literal" && typeof key.value === "string") {
        return key.value;
      }
      return null;
    };
    const checkParam = (param) => {
      let id = param;
      if (id.type === "TSParameterProperty") id = id.parameter;
      if (id.type === "AssignmentPattern") id = id.left;
      if (id.type === "RestElement") id = id.argument;
      if (id.type !== "Identifier") return;
      check(id.name, id, esTreeNodeToTSNodeMap.get(id));
    };
    const checkFunction = (node) => node.params.forEach(checkParam);
    const checkMember = (node) => {
      const name = keyName(node);
      if (name !== null) check(name, node, esTreeNodeToTSNodeMap.get(node));
    };
    return {
      FunctionDeclaration: checkFunction,
      FunctionExpression: checkFunction,
      ArrowFunctionExpression: checkFunction,
      TSFunctionType: checkFunction,
      TSConstructorType: checkFunction,
      TSMethodSignature: checkFunction,
      TSCallSignatureDeclaration: checkFunction,
      TSConstructSignatureDeclaration: checkFunction,
      TSDeclareFunction: checkFunction,
      TSEmptyBodyFunctionExpression: checkFunction,
      TSPropertySignature: checkMember,
      PropertyDefinition: checkMember,
      "Program:exit": ledger.exit,
    };
  },
};

const noBrandAssertion = {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      assertion:
        "assert to {{brand}} only at its mint site: {{remedy}}, or read it "
        + "from `select`",
      declaration:
        "declaring {{brand}} here mints it without a check: {{remedy}}, or "
        + "read it from `select`",
      overload:
        "this overload returns {{brand}} that its implementation does not: "
        + "return it from the implementation, {{remedy}}",
      launder:
        "asserting to `{{target}}` launders any value; parse it, or mark the "
        + "boundary with `// brand: untrusted -- <reason>` in a boundary "
        + "module",
      launderValue:
        "`{{type}}` returns whatever its caller names, and no body the "
        + "checker sees backs it: write a body that returns `unknown` or a "
        + "parsed value, or mark the boundary with `// brand: untrusted -- "
        + "<reason>` in a boundary module",
      optOutUnused: OPT_OUT_UNUSED,
      offTypeBrand:
        "`offType` would forge {{brand}}: {{remedy}}",
      offTypeSlot:
        "`offType`'s argument puts a value that is not {{brand}} in `{{name}}`, "
        + "a brand slot: {{remedy}}",
    },
  },
  create(context) {
    const path = repoPath(context.filename);
    const inTest = isTestCode(path);
    const { program, esTreeNodeToTSNodeMap } = servicesOf(context);
    const checker = program.getTypeChecker();
    const mayOptOut = optOutFiles.some((m) => m(path));
    const ledger = joinLedger(context);
    const inTestMint = testMintSites.some((m) => m(path));
    const typeOf = (estreeNode) =>
      checker.getTypeAtLocation(esTreeNodeToTSNodeMap.get(estreeNode));
    // Report `brands` outside their mint sites.
    const report = (node, brands, messageId) => {
      const outside = [...brands].filter((b) => !isMintSite(b, path));
      if (outside.length === 0) return;
      context.report({
        node,
        messageId,
        data: { brand: outside.join(", "), remedy: remedy(outside, inTest) },
      });
    };
    const checkBrands = (node, type, messageId) =>
      report(node, cachedBrands(checker, type), messageId);
    // Whether `type` launders beyond what `from`, where given, already
    // holds; reported unless an opt-out line allows it.
    const reportLaunder = (node, type, from) => {
      if (!cachedLaunders(checker, type)) return false;
      if (from !== undefined && !unbackedLaunder(checker, from, type)) return false;
      ledger.site(node, (optOut) => {
        if (optOut === "reason" && mayOptOut) return;
        context.report({
          node,
          messageId: "launder",
          data: { target: checker.typeToString(type) },
        });
      });
      return true;
    };
    // The operand is not consulted: an upcast is an annotated declaration
    // (`const ys: readonly BlockUid[] = xs`), never an assertion.
    // Whether the assertion is in the body of the test mint module's
    // exported `offType`, the one declared junk mint: it asserts to its type
    // parameter, which launders anywhere else.
    const inOffType = (node) => inTestMint
      && context.sourceCode.getAncestors(node).some((a) =>
        a.type === "FunctionDeclaration" && a.id?.name === OFF_TYPE
        && a.parent.type === "ExportNamedDeclaration");
    const check = (node) => {
      if (inOffType(node)) return;
      const target = node.typeAnnotation;
      if (target.type === "TSTypeReference" && target.typeName.name === "const") {
        return;
      }
      const type = typeOf(target);
      if (!reportLaunder(node, type)) checkBrands(node, type, "assertion");
    };
    // A predicate mints what its narrowing adds to the parameter's declared
    // type: narrowing a union of ops to one op adds no brand, narrowing a
    // string (or `BlockUid | string`) to BlockUid adds one. Narrowing to a
    // laundering type (`x is T`) launders like `as T` where the parameter's
    // declared type does not hold the type parameter there (`x: unknown`,
    // `x: T | string`; not `x: T | null`), except on a function type (`type
    // Guard<T> = (v: string) => v is T`): that is a contract only another
    // predicate can fulfil, and the one that does is judged at its own
    // declaration.
    const BODILESS = new Set([
      "TSFunctionType", "TSMethodSignature", "TSCallSignatureDeclaration",
    ]);
    const checkPredicate = (node) => {
      const annotation = node.typeAnnotation?.typeAnnotation;
      if (!annotation) return;
      const narrowed = typeOf(annotation);
      const fn = node.parent?.parent;
      const declared = (fn?.params ?? []).map(
        (p) => (p.type === "AssignmentPattern" ? p.left : p),
      ).find((p) => p.type === "Identifier"
        && p.name === node.parameterName.name);
      const declaredType = declared ? typeOf(declared) : undefined;
      if (!BODILESS.has(fn?.type)
        && reportLaunder(node, narrowed, declaredType)) return;
      const minted = declaredType
        ? mintedBrands(checker, declaredType, narrowed)
        : cachedBrands(checker, narrowed);
      report(node, minted, "declaration");
    };
    // An overload signature's return type is what callers see, and nothing
    // checks it against the body: a brand it adds over the implementation's
    // return type is minted. TypeScript keeps an implementation right after
    // its overloads; a predicate overload is judged as a predicate.
    const checkOverload = (node, tsNode) => {
      const siblings = ts.isClassLike(tsNode.parent)
        ? tsNode.parent.members : tsNode.parent.statements;
      if (!siblings) return;
      const name = tsNode.name?.getText();
      let i = siblings.indexOf(tsNode) + 1;
      while (i < siblings.length && siblings[i].kind === tsNode.kind
        && siblings[i].body === undefined) i++;
      const impl = siblings[i];
      if (!impl || impl.kind !== tsNode.kind || impl.body === undefined
        || impl.name?.getText() !== name) return;
      const signature = checker.getSignatureFromDeclaration(tsNode);
      const implSignature = checker.getSignatureFromDeclaration(impl);
      if (!signature || !implSignature
        || checker.getTypePredicateOfSignature(signature)) return;
      // A type parameter in the return launders like `as T`, whatever the
      // implementation: nothing ties the overload's `T` to a value the
      // caller passed. The remedy is one generic signature with no
      // overload.
      const returned = checker.getReturnTypeOfSignature(signature);
      if (reportLaunder(node, returned)) return;
      report(node, mintedBrands(
        checker,
        checker.getReturnTypeOfSignature(implSignature),
        returned,
      ), "overload");
    };
    // Whether the node sits in an ambient context: `declare` on it or on an
    // ancestor (`declare namespace`, `declare global`, `declare class`), or
    // a declaration file. An ambient declaration asserts a value exists with
    // no body to check, however deep it is nested.
    const ambientFile = /\.d\.[cm]?ts$/.test(context.filename);
    const isAmbient = (node) => ambientFile || node.declare === true
      || context.sourceCode.getAncestors(node).some((a) => a.declare === true
        || a.type === "TSModuleDeclaration" && a.kind === "global");
    // A function a caller can ask to return anything, backed by no body the
    // checker sees (`declare function mk<T>(s: string): T`): reported like
    // an assertion toward `T`.
    const reportGenericValue = (node, type) => {
      if (!genericReturn(checker, type)) return;
      ledger.site(node, (optOut) => {
        if (optOut === "reason" && mayOptOut) return;
        context.report({
          node,
          messageId: "launderValue",
          data: { type: checker.typeToString(type) },
        });
      });
    };
    // An ambient declaration mints what its type carries: nothing checks the
    // value behind it, and a generic return is whatever the caller names.
    const checkAmbient = (node, type) => {
      checkBrands(node, type, "declaration");
      reportGenericValue(node, type);
    };
    // An ambient signature's own return, which `typeOf` of the whole
    // declaration (a function type) does not carry for a generic.
    const checkAmbientSignature = (node, returnType) => {
      const annotation = returnType?.typeAnnotation;
      if (annotation && annotation.type !== "TSTypePredicate") {
        checkBrands(node, typeOf(annotation), "declaration");
      }
      const tsNode = esTreeNodeToTSNodeMap.get(node);
      const signature = checker.getSignatureFromDeclaration(tsNode);
      if (signature && !checker.getTypePredicateOfSignature(signature)) {
        reportGenericValue(node, checker.getTypeAtLocation(tsNode));
      }
    };
    // Without `declare`, a TSDeclareFunction is an overload signature.
    const checkDeclaredFunction = (node) => {
      if (isAmbient(node)) checkAmbientSignature(node, node.returnType);
      else checkOverload(node, esTreeNodeToTSNodeMap.get(node));
    };
    const checkMethodOverload = (node) => {
      if (node.value.type !== "TSEmptyBodyFunctionExpression") return;
      if (isAmbient(node)) checkAmbientSignature(node, node.value.returnType);
      else checkOverload(node, esTreeNodeToTSNodeMap.get(node));
    };
    const checkDeclaredVariable = (node) => {
      if (!isAmbient(node)) return;
      for (const d of node.declarations) {
        if (d.id.typeAnnotation) checkAmbient(d, typeOf(d.id));
      }
    };
    // A value that is not a function expression, so no body the checker
    // reads backs it, where a generic-return function type is wanted and the
    // value returns `any` (`JSON.parse`), which fits any `T`.
    const BODIED = new Set([
      "ArrowFunctionExpression", "FunctionExpression", "TSAsExpression",
      "TSTypeAssertion", "SpreadElement",
    ]);
    const checkValue = (value, contextual) => {
      if (!contextual || !genericReturn(checker, contextual)) return;
      if (anyReturning(checker, typeOf(value))) {
        reportGenericValue(value, contextual);
      }
    };
    const checkContextual = (value) => {
      if (!value || BODIED.has(value.type)) return;
      checkValue(value,
        checker.getContextualType(esTreeNodeToTSNodeMap.get(value)));
    };
    // A `declare` field, or a field of an ambient class, has no initialiser
    // to check. A field with no annotation takes its type from its
    // initialiser, so the generic-return type is declared by a base class or
    // an interface the class implements.
    const checkField = (node) => {
      const annotation = node.typeAnnotation?.typeAnnotation;
      if (annotation && isAmbient(node)) {
        checkAmbient(node, typeOf(annotation));
        return;
      }
      if (!node.value || BODIED.has(node.value.type)) return;
      if (annotation) {
        checkContextual(node.value);
        return;
      }
      const tsNode = esTreeNodeToTSNodeMap.get(node);
      const name = tsNode.name.getText();
      for (const clause of tsNode.parent.heritageClauses ?? []) {
        for (const heritage of clause.types) {
          const base = checker.getTypeAtLocation(heritage).getProperty(name);
          if (!base) continue;
          checkValue(node.value,
            checker.getTypeOfSymbolAtLocation(base, heritage));
        }
      }
    };
    // An interface merged with a class, or with a declaration in the lib or a
    // dependency (`declare global { interface Window { ... } }`), adds
    // members to a value that nothing checks: a new member mints what its
    // type carries, and a method re-declared with another return is an
    // unchecked overload, minting what it adds over each declaration it
    // overloads.
    const checkMerge = (node) => {
      const tsNode = esTreeNodeToTSNodeMap.get(node);
      const merges = (checker.getSymbolAtLocation(tsNode.name)?.declarations ?? [])
        .some((d) => d !== tsNode && (ts.isClassLike(d) || inForeignFile(d)));
      if (!merges) return;
      for (const member of node.body.body) {
        const tsMember = esTreeNodeToTSNodeMap.get(member);
        if (!tsMember.name) continue;
        const peers = (checker.getSymbolAtLocation(tsMember.name)?.declarations
          ?? []).filter((d) => d !== tsMember);
        if (peers.length === 0) {
          report(member, cachedBrands(
            checker, checker.getTypeAtLocation(tsMember)), "declaration");
          continue;
        }
        if (!ts.isMethodSignature(tsMember)) continue;
        const returned = checker.getReturnTypeOfSignature(
          checker.getSignatureFromDeclaration(tsMember));
        let minted;
        for (const peer of peers) {
          const gained = ts.isMethodDeclaration(peer) || ts.isMethodSignature(peer)
            ? mintedBrands(checker, checker.getReturnTypeOfSignature(
              checker.getSignatureFromDeclaration(peer)), returned)
            : cachedBrands(checker, returned);
          minted = minted === undefined
            ? gained : new Set([...minted].filter((b) => gained.has(b)));
        }
        report(member, minted, "declaration");
      }
    };
    return {
      CallExpression(node) {
        node.arguments.forEach(checkContextual);
        if (node.callee.type !== "Identifier" || node.callee.name !== OFF_TYPE) {
          return;
        }
        const decl = checker.getResolvedSignature(
          esTreeNodeToTSNodeMap.get(node))?.declaration;
        if (decl === undefined || !TEST_HELPERS_SOURCE.test(
          decl.getSourceFile().fileName.replace(/\.[cm]?[jt]sx?$/, ""))) return;
        const forged = (brands) => {
          const forgers = brands.map((b) => registry.malformed[b])
            .filter((stem) => stem !== undefined)
            .map((stem) => `malformed${stem[0].toUpperCase()}${stem.slice(1)}`);
          return forgers.length === brands.length
            ? `use ${forgers.join(" or ")} from ${webTestMints.join(", ")}`
            : "forge a bad brand with a malformed helper, adding one to "
              + `the test mint module (${webTestMints.join(", ")}) if the `
              + "brand has none";
        };
        const brands = [...shallowBrands(checker, typeOf(node))];
        if (brands.length > 0) {
          context.report({
            node,
            messageId: "offTypeBrand",
            data: { brand: brands.join(", "), remedy: forged(brands) },
          });
        }
        // The argument's own brand-named properties, through nested objects,
        // arrays and unions to a fixed depth, whatever the argument's source.
        const arg = node.arguments[0];
        if (arg === undefined || arg.type === "SpreadElement") return;
        const walk = (type, depth) => {
          if (depth > OFF_TYPE_DEPTH) return;
          if (type.isUnion()) return type.types.forEach((m) => walk(m, depth));
          if (checker.isArrayType(type) || checker.isTupleType(type)) {
            return checker.getTypeArguments(type)
              .forEach((m) => walk(m, depth + 1));
          }
          if (!(type.flags & (ts.TypeFlags.Object | ts.TypeFlags.Intersection))
            || isForeign(type)) {
            return undefined;
          }
          for (const symbol of checker.getPropertiesOfType(type)) {
            const own = checker.getTypeOfSymbolAtLocation(
              symbol, esTreeNodeToTSNodeMap.get(arg));
            if (Object.hasOwn(registry.names, symbol.name)
              && !declaresBrand(checker, own, registry.names[symbol.name])) {
              context.report({
                node: arg,
                messageId: "offTypeSlot",
                data: {
                  name: symbol.name,
                  brand: registry.names[symbol.name].join(" or "),
                  remedy: forged(registry.names[symbol.name]),
                },
              });
            }
            walk(own, depth + 1);
          }
          return undefined;
        };
        walk(typeOf(arg), 0);
      },
      TSAsExpression: check,
      TSTypeAssertion: check,
      TSTypePredicate: checkPredicate,
      TSDeclareFunction: checkDeclaredFunction,
      MethodDefinition: checkMethodOverload,
      VariableDeclaration: checkDeclaredVariable,
      NewExpression(node) {
        node.arguments.forEach(checkContextual);
      },
      VariableDeclarator(node) {
        checkContextual(node.init);
      },
      PropertyDefinition: checkField,
      Property(node) {
        checkContextual(node.value);
      },
      AssignmentExpression(node) {
        if (node.operator === "=") checkContextual(node.right);
      },
      ReturnStatement(node) {
        checkContextual(node.argument);
      },
      TSInterfaceDeclaration: checkMerge,
      "Program:exit": ledger.exit,
    };
  },
};

// `Object.assign`, `Object.defineProperty` and `Reflect.set` write a field
// past the type the object was declared with, and `Reflect.apply` and
// `Reflect.construct` call past the parameter types, so each puts an
// off-type value into a branded slot that neither tsc nor the rules above
// see. The two calls are reported outright. A write is reported when its
// key means a brand and its value is not already that brand: an
// `Object.assign` source (a literal's properties, or the properties of any
// other source's type), the descriptor of `defineProperty` (a getter has no
// value to check), and `Reflect.set`'s value. A key that is only a `string`
// at the call is unknown here and not reported. A reference to one of these
// functions that is not the callee of a call (`const { assign } = Object`,
// `const R = Reflect`, `.call`) is reported, so no alias hides a call.
const WATCHED = {
  Object: new Set(["assign", "defineProperty", "defineProperties"]),
  Reflect: new Set(["apply", "construct", "set", "defineProperty"]),
};
const GLOBAL_OBJECTS = new Set(["globalThis", "window", "self"]);
// `typeof Object`, `x instanceof Object`, `x === Object` and `Object(x)`
// read the constructor without reaching the functions on it.
const SAFE_BASE_PARENTS = new Set([
  "BinaryExpression", "UnaryExpression", "TSTypeQuery",
]);
const TYPE_PARENT = /^TS(TypeReference|QualifiedName|ExpressionWithTypeArguments|InterfaceHeritage|ClassImplements)$/;

const noBrandBypass = {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      call:
        "`{{api}}` calls past the parameter types, so a value that is not a "
        + "brand can reach a branded parameter: call the function directly, "
        + "or `.call` / `.apply` it",
      write:
        "`{{api}}` writes `{{name}}`, a name that means {{brand}}, without "
        + "the type check: put `{{name}}` in the object's own literal so the "
        + "type is checked, with a value that already is {{brand}}; "
        + "{{remedy}}",
      alias:
        "`{{base}}` is used other than to call one of its functions "
        + "directly: an alias (a variable, destructuring, an argument, "
        + "`.call`) hides `{{base}}.assign`, `defineProperty`, `apply` and "
        + "the rest from the bypass rule, so call them as `{{base}}.<name>(...)`",
    },
  },
  create(context) {
    const path = repoPath(context.filename);
    const inTest = isTestCode(path);
    const { program, esTreeNodeToTSNodeMap } = servicesOf(context);
    const checker = program.getTypeChecker();
    const tsNodeOf = (node) => esTreeNodeToTSNodeMap.get(node);
    const typeOf = (node) => checker.getTypeAtLocation(tsNodeOf(node));
    const staticText = (node) => {
      if (node.type === "Literal" && typeof node.value === "string") {
        return node.value;
      }
      if (node.type === "TemplateLiteral" && node.expressions.length === 0) {
        return node.quasis[0].value.cooked ?? null;
      }
      return null;
    };
    // The name `Object.assign` or `Object["assign"]` selects.
    const memberName = (member) => {
      if (!member.computed && member.property.type === "Identifier") {
        return member.property.name;
      }
      return member.computed ? staticText(member.property) : null;
    };
    // Whether `id` is the global `Object`, not a local that shadows it.
    const isGlobal = (id) => {
      for (let scope = context.sourceCode.getScope(id); scope;
        scope = scope.upper) {
        const variable = scope.set.get(id.name);
        if (variable) return variable.defs.length === 0;
      }
      return true;
    };
    // "Object" or "Reflect" for `Object`, `globalThis.Object`, ...
    const baseOf = (node) => {
      if (node.type === "Identifier") {
        return Object.hasOwn(WATCHED, node.name) && isGlobal(node) ? node.name : null;
      }
      if (node.type !== "MemberExpression") return null;
      if (node.object.type !== "Identifier") return null;
      if (!GLOBAL_OBJECTS.has(node.object.name) || !isGlobal(node.object)) {
        return null;
      }
      const name = memberName(node);
      return name !== null && Object.hasOwn(WATCHED, name) ? name : null;
    };
    const apiOf = (callee) => {
      if (callee.type !== "MemberExpression") return null;
      const base = baseOf(callee.object);
      const name = memberName(callee);
      return base !== null && name !== null && WATCHED[base].has(name)
        ? `${base}.${name}` : null;
    };
    const reportKey = (node, api, name) => {
      const wanted = registry.names[name];
      if (wanted.every((b) => isMintSite(b, path))) return;
      context.report({
        node,
        messageId: "write",
        data: {
          api,
          name,
          brand: brandText(name, wanted),
          remedy: remedy(wanted, inTest),
        },
      });
    };
    const meansBrand = (name) => Object.hasOwn(registry.names, name);
    const holdsBrand = (valueNode, name) =>
      declaresBrand(checker, typeOf(valueNode), registry.names[name]);
    // Report a brand-named `name` whose value node is not that brand.
    const checkValue = (node, api, name, valueNode) => {
      if (!meansBrand(name)) return;
      if (valueNode && holdsBrand(valueNode, name)) return;
      reportKey(node, api, name);
    };
    // A descriptor literal `{ value: x }` writes x; a getter, a non-literal
    // descriptor or no value writes something unchecked.
    const checkDescriptor = (node, api, name, descriptor) => {
      if (!meansBrand(name)) return;
      let valueNode = null;
      if (descriptor?.type === "ObjectExpression") {
        const only = descriptor.properties.every((p) => p.type === "Property"
          && !p.computed && p.key.type === "Identifier"
          && ["value", "configurable", "enumerable", "writable"]
            .includes(p.key.name));
        const value = descriptor.properties.find((p) => p.key?.name === "value");
        if (only && value) valueNode = value.value;
      }
      checkValue(node, api, name, valueNode);
    };
    // The names an object literal sets, by identifier, string or computed
    // string key.
    const literalKeys = (obj) => obj.properties.flatMap((p) => {
      if (p.type !== "Property") return [];
      let name = null;
      if (p.computed || p.key.type !== "Identifier") name = staticText(p.key);
      else name = p.key.name;
      return name === null ? [] : [[p, name]];
    });
    // The names a key argument can be: its text, or the string literals its
    // type is made of.
    const keyNames = (arg) => {
      const text = staticText(arg);
      if (text !== null) return [text];
      const type = typeOf(arg);
      const parts = type.isUnion() ? type.types : [type];
      return parts.every((t) => t.isStringLiteral())
        ? parts.map((t) => t.value) : [];
    };
    // The properties of a source's type that mean a brand and do not hold it.
    const checkSource = (arg, api) => {
      const type = typeOf(arg);
      for (const symbol of checker.getPropertiesOfType(type)) {
        if (!meansBrand(symbol.name)) continue;
        const own = checker.getTypeOfSymbolAtLocation(symbol, tsNodeOf(arg));
        if (!declaresBrand(checker, own, registry.names[symbol.name])) {
          reportKey(arg, api, symbol.name);
        }
      }
    };
    const checkAssign = (node, api) => {
      for (const arg of node.arguments.slice(1)) {
        if (arg.type === "SpreadElement") continue;
        if (arg.type !== "ObjectExpression") {
          checkSource(arg, api);
          continue;
        }
        for (const p of arg.properties) {
          if (p.type === "SpreadElement") checkSource(p.argument, api);
        }
        for (const [prop, name] of literalKeys(arg)) {
          checkValue(prop, api, name, prop.method ? null : prop.value);
        }
      }
    };
    const checkKeyWrite = (node, api, descriptorAt) => {
      const [, key] = node.arguments;
      if (!key || key.type === "SpreadElement") return;
      for (const name of keyNames(key)) {
        if (api === "Reflect.set") {
          const value = node.arguments[2];
          checkValue(key, api, name, value?.type === "SpreadElement"
            ? null : value);
        }
        else checkDescriptor(key, api, name, node.arguments[descriptorAt]);
      }
    };
    // A use of the global `Object` or `Reflect` (`outer` is the name or the
    // `globalThis.` form of it) that is not a direct call of a watched
    // function.
    const checkBaseUse = (outer, base) => {
      const parent = outer.parent;
      if (parent.type === "MemberExpression" && parent.object === outer) {
        const name = memberName(parent);
        if (name !== null && !WATCHED[base].has(name)) return;
        const grand = parent.parent;
        if (name !== null && grand.type === "CallExpression"
          && grand.callee === parent) return;
      }
      else if ((parent.type === "CallExpression"
        || parent.type === "NewExpression") && parent.callee === outer) return;
      else if (SAFE_BASE_PARENTS.has(parent.type)
        || TYPE_PARENT.test(parent.type)) return;
      context.report({ node: outer, messageId: "alias", data: { base } });
    };
    const isReference = (id) => {
      const p = id.parent;
      if (p.type === "MemberExpression" && p.property === id && !p.computed) {
        return false;
      }
      if ((p.type === "Property" || p.type === "PropertyDefinition"
        || p.type === "MethodDefinition") && p.key === id && !p.computed
        && p.value !== id) return false;
      return true;
    };
    return {
      CallExpression(node) {
        const api = apiOf(node.callee);
        if (api === "Reflect.apply" || api === "Reflect.construct") {
          context.report({ node, messageId: "call", data: { api } });
        }
        else if (api === "Object.assign") checkAssign(node, api);
        else if (api === "Object.defineProperties") {
          const [, props] = node.arguments;
          if (props?.type !== "ObjectExpression") return;
          for (const [prop, name] of literalKeys(props)) {
            checkDescriptor(prop, api, name, prop.value);
          }
        }
        else if (api === "Object.defineProperty"
          || api === "Reflect.defineProperty" || api === "Reflect.set") {
          checkKeyWrite(node, api, 2);
        }
      },
      Identifier(node) {
        if (!isReference(node)) return;
        const base = baseOf(node);
        if (base !== null) checkBaseUse(node, base);
        else if (GLOBAL_OBJECTS.has(node.name) && isGlobal(node)) {
          // `globalThis` itself aliased: `const g = globalThis`.
          const p = node.parent;
          const member = p.type === "MemberExpression" && p.object === node;
          if (!member && p.type === "VariableDeclarator" && p.init === node) {
            context.report({ node, messageId: "alias",
              data: { base: "Object` or `Reflect" } });
          }
        }
      },
      MemberExpression(node) {
        const base = baseOf(node);
        if (base !== null && node.object.type === "Identifier") {
          checkBaseUse(node, base);
          return;
        }
        // `g.Object` on an alias of the global object: the name alone says
        // what it reaches.
        const name = memberName(node);
        if (name !== null && Object.hasOwn(WATCHED, name)) {
          context.report({ node, messageId: "alias", data: { base: name } });
        }
      },
    };
  },
};

const SELECT_KEYS_MESSAGES = {
  spreadArgs:
    "`select` is called with spread arguments, so its keys are not seen: "
    + "write `db.select(sql, [\"a\", \"b\"], params)`",
  computed:
    "`select` is reached through a computed property, so its keys are not "
    + "checked: call `db.select(...)` directly",
  notLiteral:
    "ReplicaDb.select takes its keys as an array literal of string "
    + "literals (or a generic K passed through unchanged by a `select` "
    + "implementation): any other array types every column as present",
  element:
    "an element of the keys array is not a string literal (a spread, hole "
    + "or expression could name a column the query does not return)",
};

const selectKeysLiteral = {
  meta: {
    type: "problem",
    schema: [],
    messages: SELECT_KEYS_MESSAGES,
  },
  create(context) {
    const { program, esTreeNodeToTSNodeMap } = servicesOf(context);
    const checker = program.getTypeChecker();
    const typeOf = (node) =>
      checker.getTypeAtLocation(esTreeNodeToTSNodeMap.get(node));
    // Whether `member.<name>` is the `select` method of the ReplicaDb
    // interface, found by declaration so any type that extends it counts.
    const isReplicaDbSelect = (object) => {
      const decl = typeOf(object).getProperty("select")?.declarations?.[0];
      return decl !== undefined && ts.isMethodSignature(decl)
        && ts.isInterfaceDeclaration(decl.parent)
        && decl.parent.name.text === "ReplicaDb";
    };
    const hasTypeParameterElements = (type) => {
      const flagged = (t) => (t.flags & ts.TypeFlags.TypeParameter) !== 0;
      if (checker.isArrayType(type)) {
        return flagged(checker.getTypeArguments(type)[0]);
      }
      if (checker.isTupleType(type)) {
        const elements = checker.getTypeArguments(type);
        return elements.length > 0 && elements.every(flagged);
      }
      return false;
    };
    // Whether the nearest enclosing function is a `select` implementation:
    // a method, or the value of a property, named `select`. Only there can
    // a generic K forwarded unchanged have come from a checked caller.
    const inSelectImplementation = (node) => {
      const ancestors = context.sourceCode.getAncestors(node);
      const fn = ancestors.findLast((a) => /Function/.test(a.type));
      const holder = fn === undefined ? undefined : ancestors[ancestors.indexOf(fn) - 1];
      if (holder === undefined || fn.parent !== holder) return false;
      if (holder.type !== "Property" && holder.type !== "MethodDefinition") {
        return false;
      }
      if (holder.value !== fn) return false;
      const key = holder.key;
      return holder.computed
        ? key.type === "Literal" && key.value === "select"
        : key.type === "Identifier" && key.name === "select";
    };
    return {
      CallExpression(node) {
        const callee = node.callee.type === "ChainExpression"
          ? node.callee.expression : node.callee;
        if (callee.type !== "MemberExpression") return;
        if (!isReplicaDbSelect(callee.object)) return;
        if (callee.computed) {
          const p = callee.property;
          const named = p.type === "Literal" && typeof p.value === "string"
            ? p.value
            : p.type === "TemplateLiteral" && p.expressions.length === 0
              ? p.quasis[0].value.cooked : null;
          if (named !== null && named !== "select") return;
          context.report({ node, messageId: "computed" });
          return;
        }
        if (callee.property.type !== "Identifier"
          || callee.property.name !== "select") return;
        if (node.arguments.some((a) => a.type === "SpreadElement")) {
          context.report({ node, messageId: "spreadArgs" });
          return;
        }
        if (node.arguments.length < 2) return;
        const keys = node.arguments[1];
        if (keys.type === "ArrayExpression") {
          for (const el of keys.elements) {
            if (el === null || el.type !== "Literal"
              || typeof el.value !== "string") {
              context.report({ node: el ?? keys, messageId: "element" });
            }
          }
          return;
        }
        if (!(hasTypeParameterElements(typeOf(keys))
          && inSelectImplementation(node))) {
          context.report({ node: keys, messageId: "notLiteral" });
        }
      },
    };
  },
};

const PROBE_MESSAGES = {
  outsideProbe:
    "`@ts-expect-error` is allowed only inside a `typeProbe(() => { ... })` "
    + "block from the test helpers, which never runs its body; to feed a "
    + "runtime guard a value its type forbids, use `offType<T>(value)`",
};

const TEST_HELPERS_SOURCE = /(?:^|\/)test-helpers(?:\.[cm]?[jt]sx?)?$/;
const OFF_TYPE = "offType";
const OFF_TYPE_DEPTH = 4;

// The directive TypeScript reads: a line comment whose text starts with it,
// or a block comment whose last line does.
function isExpectError(comment) {
  if (comment.type === "Line") {
    return /^\/*\s*@ts-expect-error\b/.test(comment.value);
  }
  const last = comment.value.split("\n").at(-1);
  return /^[\s*]*@ts-expect-error\b/.test(last);
}

const tsExpectErrorInProbe = {
  meta: {
    type: "problem",
    schema: [],
    messages: PROBE_MESSAGES,
  },
  create(context) {
    const { sourceCode } = context;
    const bodies = [];
    // Whether `name` at `node` is the `typeProbe` import of the test
    // helpers: a local function of the same name is another binding.
    const isTypeProbe = (node) => {
      let scope = sourceCode.getScope(node);
      let variable;
      while (scope !== null && variable === undefined) {
        variable = scope.set.get(node.name);
        scope = scope.upper;
      }
      const def = variable?.defs[0];
      return def !== undefined && def.node.type === "ImportSpecifier"
        && def.node.imported.name === "typeProbe"
        && TEST_HELPERS_SOURCE.test(String(def.parent.source.value));
    };
    return {
      CallExpression(node) {
        if (node.callee.type !== "Identifier" || node.arguments.length !== 1) {
          return;
        }
        const probe = node.arguments[0];
        if (probe.type !== "ArrowFunctionExpression"
          && probe.type !== "FunctionExpression") return;
        if (isTypeProbe(node.callee)) bodies.push(probe.body.range);
      },
      "Program:exit"() {
        for (const comment of sourceCode.getAllComments()) {
          if (!isExpectError(comment)) continue;
          const [start, end] = comment.range;
          if (bodies.some(([from, to]) => from <= start && end <= to)) continue;
          context.report({ loc: comment.loc, messageId: "outsideProbe" });
        }
      },
    };
  },
};

// The test mint module may mint every brand.
function isMintSite(brand, path) {
  return testMintSites.some((m) => m(path))
    || (mintSites.get(brand) ?? []).some((m) => m(path));
}

export { isMintSite, isTestCode, pathMatcher, repoPath, testFileGlobs };

export default {
  rules: {
    "name-carries-brand": nameCarriesBrand,
    "no-brand-assertion": noBrandAssertion,
    "no-brand-bypass": noBrandBypass,
    "select-keys-literal": selectKeysLiteral,
    "ts-expect-error-in-probe": tsExpectErrorInProbe,
  },
};
