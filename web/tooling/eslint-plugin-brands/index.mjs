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
//     one are reported outside the brand's mint sites. An assertion reports
//     whatever its operand: an upcast is written as an annotated declaration
//     (`const ys: readonly BlockUid[] = xs`). A predicate mints only what
//     its narrowing adds to the parameter's declared type, and an overload
//     what its return adds over the implementation's, compared position by
//     position. An assertion, predicate or overload return toward `never`,
//     toward a type parameter a caller can instantiate with a brand its
//     constraint lacks (`T`, `T extends string`, `K extends "a"`), or
//     toward `keyof T`, whose keys the caller picks (`keyof Record<BlockUid,
//     1>`), launders any value, also inside `T[]`, `{ v: T }`, `Promise<T>`
//     ..., and is allowed only on a `brand: untrusted -- <reason>` line in
//     an opt-out file.
//   * brands/no-brand-bypass: `Reflect.apply`, and a brand-named field
//     written through `Object.assign` or `Object.defineProperty`, which skip
//     the checks the two rules above rely on tsc to raise.
//   * brands/select-keys-literal: the keys argument of `ReplicaDb.select` is
//     an array literal of string literals, or an array or tuple whose
//     element type is a type parameter inside a method or property named
//     `select` (a wrapper passing its generic keys through). Any other
//     array could widen K to every column. Not a brand rule; it lives here
//     as the repo's type-aware rule home.
// All but the last read tooling/brandRegistry.gen.json, generated from the
// server's brand registry, and all apply to tests as they do to product code.
// The test mint module (`testMintSites`) is a mint site for every brand, and
// in test code (`*.test.*` and the registry's `testCode` paths) a report names
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
const SUBTYPE_KEY = "__canonical";
const SUBTYPE_BRAND = "CanonicalTitle";
const SUBTYPE_PARENT = "NormalizedTitle";
const BRAND_TAGS = new Set(["__brand", SUBTYPE_KEY]);

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
      // A subtype brand adds a `__canonical` key to its parent's brand
      // (api/brands.ts), so the intersection names the subtype, which has
      // its own mint sites, not the parent.
      if (t.isIntersection() && t.types.some((m) => m.getProperty(SUBTYPE_KEY))) {
        const inner = new Set();
        for (const m of t.types) brandsOf(checker, m).forEach((b) => inner.add(b));
        inner.delete(SUBTYPE_PARENT);
        inner.add(SUBTYPE_BRAND);
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
      // brand in the predicate of its call signature.
      if (!foreign) {
        for (const sig of checker.getSignaturesOfType(t, ts.SignatureKind.Call)) {
          const predicate = checker.getTypePredicateOfSignature(sig);
          if (predicate?.type) walk(predicate.type);
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

// An assertion toward this type accepts any value: `never`, or a laundering
// type parameter anywhere in it (`T`, `T[]`, `{ v: T }`, `Promise<T>`,
// `T & {}`, `T[K]`, `Partial<T>`, `ReturnType<F>` ...), walked like
// brandsOf walks brands, and through the arguments of any type alias. Alias
// arguments, index keys and a mapped type's keys are walked as keys; the
// structure behind an alias is walked as values.
function launders(checker, type) {
  const seen = [new Set(), new Set()];
  const walk = (t, asValue = true) => {
    const visited = seen[asValue ? 1 : 0];
    if (visited.has(t)) return false;
    visited.add(t);
    const key = (u) => walk(u, false);
    if (t.flags & ts.TypeFlags.Never) return true;
    if (t.flags & ts.TypeFlags.TypeParameter) {
      return laundersParam(checker, t, asValue);
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
      || infos.some((i) => key(i.keyType) || walk(i.type));
  };
  return walk(type);
}

// The brand literal a type itself carries (not one nested inside it).
function ownBrand(checker, type) {
  const brand = type.getProperty("__brand");
  if (!brand) return null;
  const bt = checker.getTypeOfSymbol(brand);
  return bt.isStringLiteral() ? bt.value : null;
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
  const compare = (source, target) => add(source === undefined
    ? cachedBrands(checker, target) : mintedBrands(checker, source, target, seen));
  if (from === to) return minted;
  if (from.flags & ts.TypeFlags.Any) return every();
  if (from.isUnion()) {
    for (const m of from.types) {
      if (overlaps(checker, m, to)) add(mintedBrands(checker, m, to, seen));
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
    // A member `from` is gains nothing. Otherwise a member `from` could be
    // is compared, and a member it cannot be (a discriminant rules it out)
    // still lends the union its properties: `{ k: 1 }` believed to be
    // `{ k: 1 } | { k: 2; uid?: BlockUid }` reads `uid` as a BlockUid. A
    // `from` that could be no member (`null` believed to be `BlockUid |
    // undefined`) gains every brand.
    if (to.types.includes(from)) return minted;
    let overlapping = false;
    for (const m of to.types) {
      if (overlaps(checker, from, m)) {
        overlapping = true;
        add(mintedBrands(checker, from, m, seen));
      }
      else if (isObjectish(m) && isObjectish(from)) add(undeclaredBrands(checker, from, m));
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

// "reason" for `// brand: untrusted -- <why>` on the node's line or the one
// above, "bare" for the marker with no reason, null when there is none.
function optOutOf(sourceCode, node) {
  const line = node.loc.start.line;
  let found = null;
  for (const c of sourceCode.getAllComments()) {
    if (c.loc.end.line !== line && c.loc.end.line !== line - 1) continue;
    if (/^\s*brand: untrusted -- \S/.test(c.value)) return "reason";
    if (/^\s*brand: untrusted\b/.test(c.value)) found = "bare";
  }
  return found;
}

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
    parts.push(`mint it in ${shown}${modules.length > MODULES_SHOWN ? " ..." : ""}`);
  }
  else parts.push("register a web mint site for it in the brand registry");
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
    },
  },
  create(context) {
    const path = repoPath(context.filename);
    const inTest = isTestCode(path);
    const { program, esTreeNodeToTSNodeMap } = servicesOf(context);
    const checker = program.getTypeChecker();
    const mayOptOut = optOutFiles.some((m) => m(path));

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
      const optOut = optOutOf(context.sourceCode, anchor);
      if (optOut === "reason" && mayOptOut) return;
      let messageId = "missing";
      if (optOut === "reason") messageId = "optOut";
      else if (optOut === "bare" && mayOptOut) messageId = "noReason";
      context.report({ node: anchor, messageId, data });
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
      TSDeclareFunction: checkFunction,
      TSEmptyBodyFunctionExpression: checkFunction,
      TSPropertySignature: checkMember,
      PropertyDefinition: checkMember,
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
    },
  },
  create(context) {
    const path = repoPath(context.filename);
    const inTest = isTestCode(path);
    const { program, esTreeNodeToTSNodeMap } = servicesOf(context);
    const checker = program.getTypeChecker();
    const mayOptOut = optOutFiles.some((m) => m(path));
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
    // Whether `type` launders; reported unless an opt-out line allows it.
    // Whether `type` launders beyond what `from`, where given, already
    // holds; reported unless an opt-out line allows it.
    const reportLaunder = (node, type, from) => {
      if (!cachedLaunders(checker, type)) return false;
      if (from !== undefined && !unbackedLaunder(checker, from, type)) return false;
      const optOut = optOutOf(context.sourceCode, node);
      if (optOut !== "reason" || !mayOptOut) {
        context.report({
          node,
          messageId: "launder",
          data: { target: checker.typeToString(type) },
        });
      }
      return true;
    };
    // The operand is not consulted: an upcast is an annotated declaration
    // (`const ys: readonly BlockUid[] = xs`), never an assertion.
    const check = (node) => {
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
    // `declare` asserts a function exists with no body to check; without it
    // a TSDeclareFunction is an overload signature.
    const checkDeclaredFunction = (node) => {
      if (!node.declare) {
        checkOverload(node, esTreeNodeToTSNodeMap.get(node));
        return;
      }
      const annotation = node.returnType?.typeAnnotation;
      if (annotation && annotation.type !== "TSTypePredicate") {
        checkBrands(node, typeOf(annotation), "declaration");
      }
    };
    const checkMethodOverload = (node) => {
      if (node.value.type !== "TSEmptyBodyFunctionExpression") return;
      checkOverload(node, esTreeNodeToTSNodeMap.get(node));
    };
    const checkDeclaredVariable = (node) => {
      if (!node.declare) return;
      for (const d of node.declarations) {
        if (d.id.typeAnnotation) {
          checkBrands(d, typeOf(d.id), "declaration");
        }
      }
    };
    return {
      TSAsExpression: check,
      TSTypeAssertion: check,
      TSTypePredicate: checkPredicate,
      TSDeclareFunction: checkDeclaredFunction,
      MethodDefinition: checkMethodOverload,
      VariableDeclaration: checkDeclaredVariable,
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
  },
};
