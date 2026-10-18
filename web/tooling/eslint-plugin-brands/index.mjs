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
//     one are reported outside the brand's mint sites. A predicate mints
//     only what its narrowing adds to the parameter's declared type, and an
//     overload what its return adds over the implementation's, compared
//     position by position. An assertion whose operand already fits its
//     target mints nothing. An assertion toward `never`, toward a type
//     parameter a caller can instantiate with a brand its constraint lacks
//     (`T`, `T extends string`, `K extends "a"`), or toward `keyof T`, whose
//     keys the caller picks (`keyof Record<BlockUid, 1>`), launders any
//     value, also inside `T[]`, `{ v: T }`, `Promise<T>` ..., and is allowed
//     only on a `brand: untrusted -- <reason>` line in an opt-out file.
// Both read tooling/brandRegistry.gen.json, generated from the server's
// brand registry, and both skip test files and the registry's test-support
// paths. `satisfies` and non-null `!` are not assertions toward a brand and
// are left alone.
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

const testSupport = registry.testSupport.map(pathMatcher);
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

function isExempt(path) {
  return /\.test\.[cm]?[jt]sx?$/.test(path)
    || testSupport.some((m) => m(path));
}

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

// Whether `any` sits anywhere in a type: it fits every target, so an
// assertion from it is judged as if its operand were unknown.
function hasAny(checker, type) {
  const seen = new Set();
  const walk = (t) => {
    if (seen.has(t)) return false;
    seen.add(t);
    if (t.flags & ts.TypeFlags.Any) return true;
    if (t.flags & ts.TypeFlags.Instantiable) {
      const constraint = checker.getBaseConstraintOfType(t);
      return constraint !== undefined && constraint !== t && walk(constraint);
    }
    if (t.isUnionOrIntersection()) return t.types.some(walk);
    if (!(t.flags & ts.TypeFlags.Object)) return false;
    if ((checker.isArrayType(t) || checker.isTupleType(t)
      || t.objectFlags & ts.ObjectFlags.Reference)
      && checker.getTypeArguments(t).some(walk)) return true;
    if (isForeign(t) && !(t.objectFlags & ts.ObjectFlags.Mapped)) return false;
    return t.getProperties().some((p) => walk(checker.getTypeOfSymbol(p)))
      || checker.getIndexInfosOfType(t).some((i) => walk(i.type));
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

// The lib or own references a reference type extends, with the base's type
// arguments written in terms of the reference's own: `Index<BlockUid, V>`
// extending `Map<K, V>` gives `Map` with [BlockUid, V]. A base whose
// arguments are not plain type parameters of the reference is skipped.
function instantiatedBases(checker, type) {
  if (!(type.objectFlags & ts.ObjectFlags.Reference)) return [];
  const params = type.target.typeParameters ?? [];
  const args = checker.getTypeArguments(type);
  const bases = [];
  for (const base of checker.getBaseTypes(type.target) ?? []) {
    if (!(base.objectFlags & ts.ObjectFlags.Reference)) continue;
    const mapped = checker.getTypeArguments(base).map((a) => {
      const i = params.indexOf(a);
      return i >= 0 ? args[i] : undefined;
    });
    if (mapped.every((a) => a !== undefined)) {
      bases.push({ target: base.target, args: mapped });
    }
  }
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

// The brands a value typed `from` gains by being believed to be `to` (a
// type predicate's narrowing, an overload's return). None where `from`
// already fits `to`. Otherwise each position of `to` is compared with the
// matching position of `from`: an array or tuple element with `from`'s
// element, a reference's type arguments with those of the same generic
// type or of a lib type of the same arity (`ReadonlySet` to `Set`,
// `PromiseLike` to `Promise`), an object's properties and index signatures
// with `from`'s. Where no position
// matches, every brand of `to` is minted: a brand elsewhere in `from` does
// not cover it. Only the members of a `from` union that could hold a `to`
// are compared: `BlockUid | null` narrowed to `BlockUid` gains none,
// `BlockUid | string` gains BlockUid from its string.
function mintedBrands(checker, from, to, seen = new Map()) {
  const minted = new Set();
  const add = (brands) => brands.forEach((b) => minted.add(b));
  const every = () => new Set(cachedBrands(checker, to));
  const compare = (source, target) => add(source === undefined
    ? cachedBrands(checker, target) : mintedBrands(checker, source, target, seen));
  if (from.flags & ts.TypeFlags.Any) return every();
  if (from.isUnion()) {
    for (const m of from.types) {
      if (overlaps(checker, m, to)) add(mintedBrands(checker, m, to, seen));
    }
    return minted;
  }
  if (checker.isTypeAssignableTo(from, to)) return minted;
  if (from.flags & ts.TypeFlags.TypeParameter) {
    const constraint = checker.getBaseConstraintOfType(from);
    return mintedBrands(checker, constraint ?? checker.getUnknownType(), to, seen);
  }
  if (to.isUnion()) {
    for (const m of to.types) {
      if (overlaps(checker, from, m)) add(mintedBrands(checker, from, m, seen));
    }
    return minted;
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
  for (const p of to.getProperties()) {
    const source = from.getProperty(p.name);
    position(source && checker.getTypeOfSymbol(source),
      checker.getTypeOfSymbol(p));
  }
  // Our own `class Index<K, V> extends Map<K, V>` holds its arguments where
  // its lib base does: compare them with a `from` of that lib type.
  if (isReference(from) && isForeign(from)) {
    const fromArgs = checker.getTypeArguments(from);
    for (const base of instantiatedBases(checker, to)) {
      if (base.target === from.target) {
        base.args.forEach((t, i) => position(fromArgs[i], t));
      }
    }
  }
  const fromInfos = checker.getIndexInfosOfType(from);
  for (const info of checker.getIndexInfosOfType(to)) {
    cachedBrands(checker, info.keyType).forEach((b) => accounted.add(b));
    const same = fromInfos.find((i) => i.keyType === info.keyType);
    if (same) position(same.type, info.type);
    else {
      add(cachedBrands(checker, info.keyType));
      add(cachedBrands(checker, info.type));
    }
  }
  for (const b of cachedBrands(checker, to)) if (!accounted.has(b)) minted.add(b);
  return minted;
}

// A mapped type over a type parameter (no members until instantiated) whose
// declaration makes every key optional: `Partial<T>`, `{ [P in K]?: X }`.
function isOptionalGenericMapping(checker, type) {
  if (!(type.objectFlags & ts.ObjectFlags.Mapped)
    || type.getProperties().length > 0
    || checker.getIndexInfosOfType(type).length > 0) return false;
  const question = type.symbol?.declarations?.find(ts.isMappedTypeNode)
    ?.questionToken;
  return question !== undefined && question.kind !== ts.SyntaxKind.MinusToken;
}

// The types a generic mapped type maps over: its alias's arguments
// (`Partial<T>` maps over T), or the `T` of `keyof T` in a mapped type
// written in place.
function mappedOver(checker, type) {
  const over = [...(type.aliasTypeArguments ?? [])];
  const decl = type.symbol?.declarations?.find(ts.isMappedTypeNode);
  const keys = decl?.typeParameter.constraint;
  if (keys && checker.getTypeFromTypeNode(decl) === type) {
    const keyType = checker.getTypeFromTypeNode(keys);
    if (keyType.flags & ts.TypeFlags.Index) over.push(keyType.type);
  }
  return over;
}

// Whether a property of `to` carrying a brand or a laundering parameter is
// one `from` does not back. A property `from` does not declare holds what
// its string index allows, or anything.
function unbackedProperties(checker, from, to, seen) {
  const stringIndex = checker.getIndexTypeOfType(from, ts.IndexKind.String);
  return to.getProperties().some((p) => {
    const target = checker.getTypeOfSymbol(p);
    const declared = from.getProperty(p.name);
    const source = declared ? checker.getTypeOfSymbol(declared) : stringIndex;
    if (source !== undefined) return unbacked(checker, source, target, seen);
    return cachedBrands(checker, target).size > 0
      || cachedLaunders(checker, target);
  });
}

// Whether `to`, which `from` fits, has a position carrying a brand or a
// laundering parameter that `from` does not declare: an optional property,
// an optional or rest tuple element past `from`'s length, or an index
// signature `from` lacks. Width subtyping lets a value of `from` hold
// anything there, so an assertion to `to` believes an unchecked brand
// (`row as Row & { uid?: BlockUid }`).
function unbacked(checker, from, to, seen = new Map()) {
  const carries = (t) => cachedBrands(checker, t).size > 0
    || cachedLaunders(checker, t);
  if (from === to || from.flags & ts.TypeFlags.Never || !carries(to)) {
    return false;
  }
  if (from.isUnion()) return from.types.some((m) => unbacked(checker, m, to, seen));
  if (to.isUnion()) {
    // The operand must fit some member with no gap, and a property every
    // member declares must be backed too: it reads through the union
    // without narrowing to the member the operand fits.
    const fits = to.types.some((m) => checker.isTypeAssignableTo(from, m)
      && !unbacked(checker, from, m, seen));
    return !fits || unbackedProperties(checker, from, to, seen);
  }
  // A position reached through an index signature or an optional property
  // need not fit at all (`Record<string, string>` fits `{ uid?: BlockUid }`).
  if (!checker.isTypeAssignableTo(from, to)) return true;
  const targets = seen.get(from) ?? new Set();
  if (targets.has(to)) return false;
  seen.set(from, targets.add(to));
  if (ownBrand(checker, to) === null && to.isIntersection()) {
    return to.types.some((m) => unbacked(checker, from, m, seen));
  }
  if (isOptionalGenericMapping(checker, to)) {
    // `Partial<T>` over a type parameter has no members to compare until
    // instantiated, and `object` fits it: only the type it maps over backs
    // it.
    return !mappedOver(checker, to).includes(from);
  }
  const isReference = (t) => (t.objectFlags & ts.ObjectFlags.Reference) !== 0;
  if (checker.isTupleType(to)) {
    const toElements = checker.getTypeArguments(to);
    const fromElements = checker.isTupleType(from)
      ? checker.getTypeArguments(from) : [];
    const element = elementOf(checker, from);
    return toElements.some((t, i) => {
      const source = checker.isTupleType(from) ? fromElements[i] : element;
      return source === undefined ? carries(t) : unbacked(checker, source, t, seen);
    });
  }
  if (checker.isArrayType(to)) {
    const element = elementOf(checker, from);
    const [target] = checker.getTypeArguments(to);
    return element === undefined || unbacked(checker, element, target, seen);
  }
  if (isReference(to) && isReference(from)) {
    const fromArgs = checker.getTypeArguments(from);
    const toArgs = checker.getTypeArguments(to);
    const libPair = isForeign(from) && isForeign(to)
      && fromArgs.length === toArgs.length;
    if (from.target === to.target || libPair) {
      return toArgs.some((t, i) => unbacked(checker, fromArgs[i], t, seen));
    }
  }
  if (!isObjectish(to)) return false;
  if (unbackedProperties(checker, from, to, seen)) return true;
  const fromInfos = checker.getIndexInfosOfType(from);
  return checker.getIndexInfosOfType(to).some((info) => {
    // A `string` key does not back a `BlockUid` key.
    const same = fromInfos.find(
      (i) => checker.isTypeAssignableTo(i.keyType, info.keyType),
    );
    if (same) return unbacked(checker, same.type, info.type, seen);
    return carries(info.keyType) || carries(info.type);
  });
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
const cachedHasAny = (checker, type) => cachedBy(hasAny, checker, type);

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

// "parseBlockUid, or mint it in web/src/uid.ts" from the registry's web mint
// modules for these brands.
function remedy(brands) {
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
    if (isExempt(path)) return {};
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
        remedy: remedy(wanted),
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
    if (isExempt(path)) return {};
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
        data: { brand: outside.join(", "), remedy: remedy(outside) },
      });
    };
    const checkBrands = (node, type, messageId) =>
      report(node, cachedBrands(checker, type), messageId);
    const check = (node) => {
      const target = node.typeAnnotation;
      if (target.type === "TSTypeReference" && target.typeName.name === "const") {
        return;
      }
      const type = typeOf(target);
      const launder = cachedLaunders(checker, type);
      if (!launder && ![...cachedBrands(checker, type)].some(
        (b) => !isMintSite(b, path),
      )) return;
      // An operand that already fits the target, at every position the
      // target carries a brand, is only widened (`xs as readonly T[]`,
      // `[] as T[]`): nothing is laundered or minted.
      const operand = typeOf(node.expression);
      if (!cachedHasAny(checker, operand)
        && checker.isTypeAssignableTo(operand, type)
        && !unbacked(checker, operand, type)) return;
      if (launder) {
        const optOut = optOutOf(context.sourceCode, node);
        if (optOut === "reason" && mayOptOut) return;
        context.report({
          node,
          messageId: "launder",
          data: { target: checker.typeToString(type) },
        });
        return;
      }
      checkBrands(node, type, "assertion");
    };
    // A predicate mints what its narrowing adds to the parameter's declared
    // type: narrowing a union of ops to one op adds no brand, narrowing a
    // string (or `BlockUid | string`) to BlockUid adds one.
    const checkPredicate = (node) => {
      const annotation = node.typeAnnotation?.typeAnnotation;
      if (!annotation) return;
      const fn = node.parent?.parent;
      const declared = (fn?.params ?? []).map(
        (p) => (p.type === "AssignmentPattern" ? p.left : p),
      ).find((p) => p.type === "Identifier"
        && p.name === node.parameterName.name);
      const narrowed = typeOf(annotation);
      const minted = declared
        ? mintedBrands(checker, typeOf(declared), narrowed)
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
      report(node, mintedBrands(
        checker,
        checker.getReturnTypeOfSignature(implSignature),
        checker.getReturnTypeOfSignature(signature),
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

function isMintSite(brand, path) {
  return (mintSites.get(brand) ?? []).some((m) => m(path));
}

export { isExempt, isMintSite, pathMatcher, repoPath };

export default {
  rules: {
    "name-carries-brand": nameCarriesBrand,
    "no-brand-assertion": noBrandAssertion,
  },
};
