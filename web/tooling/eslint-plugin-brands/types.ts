// pattern: Imperative Shell
import type { ParserServicesWithTypeInformation, TSESLint } from "@typescript-eslint/utils";
import ts from "typescript";

const SET_TYPES = new Set(["Set", "ReadonlySet"]);
const MAP_TYPES = new Set(["Map", "ReadonlyMap"]);
// The subtype chain of api/brands.ts, most derived first: [key, brand].
const SUBTYPES: readonly (readonly [key: string, brand: string])[] = [
  ["__canonical", "CanonicalTitle"],
  ["__normalized", "NormalizedTitle"],
];
// The `__brand` brand every subtype in the chain sits on.
const SUBTYPE_ROOT = "RawTitle";
const BRAND_TAGS = new Set(["__brand", ...SUBTYPES.map(([key]) => key)]);

const SIGNATURE_KINDS = [ts.SignatureKind.Call, ts.SignatureKind.Construct];

// The flag tests TypeScript's own checker narrows by, as type guards.
const isObject = (t: ts.Type): t is ts.ObjectType =>
  (t.flags & ts.TypeFlags.Object) !== 0;
const isReference = (t: ts.Type): t is ts.TypeReference =>
  isObject(t) && (t.objectFlags & ts.ObjectFlags.Reference) !== 0;
const isMapped = (t: ts.Type): boolean =>
  isObject(t) && (t.objectFlags & ts.ObjectFlags.Mapped) !== 0;
const isIndexedAccess = (t: ts.Type): t is ts.IndexedAccessType =>
  (t.flags & ts.TypeFlags.IndexedAccess) !== 0;
const isIndex = (t: ts.Type): t is ts.IndexType =>
  (t.flags & ts.TypeFlags.Index) !== 0;
const isConditional = (t: ts.Type): t is ts.ConditionalType =>
  (t.flags & ts.TypeFlags.Conditional) !== 0;
// An array or tuple: a reference whose arguments are its elements.
export const isArrayLike = (checker: ts.TypeChecker, t: ts.Type): t is ts.TypeReference =>
  isReference(t) && (checker.isArrayType(t) || checker.isTupleType(t));
// A type's symbol name, "" for a type with no symbol.
const symbolName = (t: ts.Type): string => t.symbol?.name ?? "";

// A type declared only in the TypeScript lib or a dependency.
export function isForeign(type: ts.Type): boolean {
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
function brandsOf(checker: ts.TypeChecker, type: ts.Type): Set<string> {
  const found = new Set<string>();
  const seen = new Set<ts.Type>();
  const walk = (t: ts.Type): void => {
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
        const inner = new Set<string>();
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
    if (isObject(t)) {
      if (isReference(t)) checker.getTypeArguments(t).forEach(walk);
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
      const mapped = isMapped(t);
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
const isUnit = (t: ts.Type): boolean =>
  t.isUnion() ? t.types.every(isUnit) : (t.flags & UNIT) !== 0;
const isObjectish = (t: ts.Type) =>
  (t.flags & (ts.TypeFlags.Object | ts.TypeFlags.NonPrimitive)) !== 0;
const isNullish = (t: ts.Type) => (t.flags
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
function laundersParam(
  checker: ts.TypeChecker, param: ts.Type, asValue: boolean,
): boolean {
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
function mentions(
  checker: ts.TypeChecker, type: ts.Type, param: ts.Type,
  seen = new Set<ts.Type>(),
): boolean {
  if (seen.has(type)) return false;
  seen.add(type);
  if (type === param) return true;
  const go = (t: ts.Type) => mentions(checker, t, param, seen);
  if (type.aliasTypeArguments?.some(go)) return true;
  if (isIndexedAccess(type)) {
    return go(type.objectType) || go(type.indexType);
  }
  if (isIndex(type)) return go(type.type);
  if (isConditional(type)) {
    return go(type.checkType) || go(type.extendsType);
  }
  if (type.isUnionOrIntersection()) return type.types.some(go);
  if (!isObject(type)) return false;
  if (isReference(type) && checker.getTypeArguments(type).some(go)) return true;
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
export function launders(
  checker: ts.TypeChecker, type: ts.Type, neverLaunders = true,
): boolean {
  const seen = [new Set<ts.Type>(), new Set<ts.Type>()];
  // The type parameters of a function type in the target that a parameter
  // of that function mentions (`transaction<T>(fn: () => T): T`): its caller
  // ties them to a value they passed. Inside a return, `never` is a function
  // that does not come back.
  const tied = new Set<ts.Type>();
  let inReturn = 0;
  const walk = (t: ts.Type, asValue = true): boolean => {
    const visited = seen[asValue ? 1 : 0];
    if (visited.has(t)) return false;
    visited.add(t);
    const key = (u: ts.Type) => walk(u, false);
    if (t.flags & ts.TypeFlags.Never) return neverLaunders && inReturn === 0;
    if (t.flags & ts.TypeFlags.TypeParameter) {
      return !tied.has(t) && laundersParam(checker, t, asValue);
    }
    // `keyof T` (or `keyof T[K]`) stays unresolved only while its keys come
    // from a type parameter, and a caller picks them: `keyof
    // Record<BlockUid, 1>` is a BlockUid. A concrete `keyof Row` resolves to
    // its literal keys and never reaches here.
    if (isIndex(t)) return true;
    if (t.aliasTypeArguments?.some(key)) return true;
    if (isIndexedAccess(t)) {
      return walk(t.objectType) || key(t.indexType);
    }
    if (isConditional(t)) {
      const constraint = checker.getBaseConstraintOfType(t);
      return walk(t.checkType, asValue)
        || constraint !== undefined && walk(constraint, asValue);
    }
    if (t.isUnionOrIntersection()) return t.types.some((m) => walk(m, asValue));
    if (!isObject(t)) return false;
    if (isReference(t)) {
      if (checker.getTypeArguments(t).some((a) => walk(a))) return true;
    }
    const mapped = isMapped(t);
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
  const walkReturn = (sig: ts.Signature) => {
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
function ownBrand(checker: ts.TypeChecker, type: ts.Type): string | null {
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
export function shallowBrands(checker: ts.TypeChecker, type: ts.Type): Set<string> {
  const found = new Set<string>();
  const walk = (t: ts.Type): void => {
    if (t.isUnion()) return t.types.forEach(walk);
    const own = ownBrand(checker, t);
    if (own !== null) {
      found.add(own);
      return undefined;
    }
    if (isArrayLike(checker, t)) {
      return checker.getTypeArguments(t).forEach(walk);
    }
    const name = symbolName(t);
    if (isReference(t) && (SET_TYPES.has(name) || MAP_TYPES.has(name))) {
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
export function declaresBrand(
  checker: ts.TypeChecker, type: ts.Type, wanted: readonly string[],
): boolean {
  if (type.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)) return true;
  if (type.isUnion()) {
    return type.types.every((m) => declaresBrand(checker, m, wanted));
  }
  const own = ownBrand(checker, type);
  if (own !== null) return wanted.includes(own);
  if (isArrayLike(checker, type)) {
    const elems = checker.getTypeArguments(type);
    return elems.length > 0
      && elems.every((e) => declaresBrand(checker, e, wanted));
  }
  const name = symbolName(type);
  if (isReference(type) && (SET_TYPES.has(name) || MAP_TYPES.has(name))) {
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
function overlaps(checker: ts.TypeChecker, a: ts.Type, b: ts.Type): boolean {
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
    const isNumeric = (name: string) => String(Number(name)) === name;
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
interface Base {
  target: ts.GenericType;
  args: ts.Type[];
}

function instantiatedBases(checker: ts.TypeChecker, type: ts.Type): Base[] {
  if (!isReference(type)) return [];
  const bases: Base[] = [];
  const seen = new Set<ts.Type>();
  const walk = (target: ts.InterfaceType, args: readonly ts.Type[]) => {
    if (seen.has(target)) return;
    seen.add(target);
    const params: readonly ts.Type[] = target.typeParameters ?? [];
    for (const base of checker.getBaseTypes(target)) {
      if (!isReference(base)) continue;
      const mapped = checker.getTypeArguments(base).map((a) => {
        const i = params.indexOf(a);
        return i >= 0 ? args[i] : undefined;
      });
      if (!mapped.every((a): a is ts.Type => a !== undefined)) continue;
      bases.push({ target: base.target, args: mapped });
      walk(base.target, mapped);
    }
  };
  walk(type.target, checker.getTypeArguments(type));
  return bases;
}

// What an array-like or iterable type holds: its number index type, or the
// first type argument of a reference (`Iterable<T>`, `ReadonlySet<T>`).
function elementOf(checker: ts.TypeChecker, type: ts.Type): ts.Type | undefined {
  const indexed = checker.getIndexTypeOfType(type, ts.IndexKind.Number);
  if (indexed) return indexed;
  if (!isReference(type)) return undefined;
  return checker.getTypeArguments(type).at(0);
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
export function unbackedLaunder(
  checker: ts.TypeChecker, from: ts.Type, to: ts.Type,
  seen = new Map<ts.Type, Set<ts.Type>>(),
): boolean {
  if (from === to || !cachedLaunders(checker, to)) return false;
  // `any` fits every type parameter and holds none: a guard over
  // `MessageEvent["data"]` narrows a string to any `T`.
  if (from.flags & ts.TypeFlags.Any) return true;
  const unheld = (source: ts.Type | undefined, target: ts.Type): boolean =>
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
  if (!isObject(to)) return !checker.isTypeAssignableTo(from, to);
  if (isArrayLike(checker, to)) {
    const fromElements = isReference(from) && checker.isTupleType(from)
      && checker.isTupleType(to) ? checker.getTypeArguments(from) : [];
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
  if (isForeign(to) && !isMapped(to)) {
    return !checker.isTypeAssignableTo(from, to);
  }
  const props = to.getProperties();
  const infos = checker.getIndexInfosOfType(to);
  if (isMapped(to) && props.length === 0
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
      if (isIndex(keyType)) over.push(keyType.type);
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
function undeclaredBrands(
  checker: ts.TypeChecker, from: ts.Type, to: ts.Type,
): Set<string> {
  const found = new Set<string>();
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
export function mintedBrands(
  checker: ts.TypeChecker, from: ts.Type, to: ts.Type,
  seen = new Map<ts.Type, Set<ts.Type>>(),
): Set<string> {
  const minted = new Set<string>();
  const add = (brands: ReadonlySet<string>) => brands.forEach((b) => minted.add(b));
  const every = () => new Set(cachedBrands(checker, to));
  // What a member `to` lends `from` where `from` cannot be it: the brands of
  // the properties `from` does not declare.
  const lentBy = (source: ts.Type, member: ts.Type) => {
    if (overlaps(checker, source, member)) {
      return mintedBrands(checker, source, member, seen);
    }
    return isObjectish(member) && isObjectish(source)
      ? undeclaredBrands(checker, source, member) : new Set<string>();
  };
  const compare = (source: ts.Type | undefined, target: ts.Type) => add(source === undefined
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
    let common: Set<string> | undefined;
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
  // An intersection that is not itself a brand (`Set<BlockUid> & { a: 1 }`)
  // mints what any of its members does, each taking its own path.
  if (ownBrand(checker, to) === null && to.isIntersection()) {
    for (const m of to.types) add(mintedBrands(checker, from, m, seen));
    return minted;
  }
  if (isArrayLike(checker, to)) {
    const fromElements = isReference(from) && checker.isTupleType(from)
      && checker.isTupleType(to) ? checker.getTypeArguments(from) : [];
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
    && (!isForeign(to) || isMapped(to));
  if (!structural) return every();
  // A brand of `to` that no compared position holds (the `T` of our own
  // `interface TaggedSet<T> extends Set<T>`, reached only through method
  // signatures) is minted too.
  const accounted = new Set<string>();
  const position = (source: ts.Type | undefined, target: ts.Type) => {
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
    const applies = (i: ts.IndexInfo) => checker.isTypeAssignableTo(info.keyType, i.keyType)
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

export function servicesOf(
  context: Readonly<TSESLint.RuleContext<string, readonly unknown[]>>,
): Pick<ParserServicesWithTypeInformation, "program" | "esTreeNodeToTSNodeMap"> {
  const services = context.sourceCode.parserServices;
  const program = services?.program;
  const esTreeNodeToTSNodeMap = services?.esTreeNodeToTSNodeMap;
  if (!program || !esTreeNodeToTSNodeMap) {
    throw new Error("brands rules need type information (projectService)");
  }
  return { program, esTreeNodeToTSNodeMap };
}

// Brand and launder detection are cached per type for the lifetime of a
// program.
type Compute<T> = (checker: ts.TypeChecker, type: ts.Type) => T;
function cachedBy<T>(compute: Compute<T>): Compute<T> {
  const byChecker = new WeakMap<ts.TypeChecker, Map<ts.Type, T>>();
  return (checker, type) => {
    let cache = byChecker.get(checker);
    if (!cache) byChecker.set(checker, cache = new Map<ts.Type, T>());
    const hit = cache.get(type);
    if (hit !== undefined) return hit;
    const computed = compute(checker, type);
    cache.set(type, computed);
    return computed;
  };
}
export const cachedBrands: Compute<Set<string>> = cachedBy(brandsOf);
export const cachedLaunders: Compute<boolean> = cachedBy(
  (checker, type) => launders(checker, type),
);
// What a function returns launders unless it is `never`: a function that
// returns `never` never produces a value.
const cachedLaunderingReturn = cachedBy(
  (checker, type) => launders(checker, type, false),
);

const members = (type: ts.Type) => (type.isUnion() ? type.types : [type]);

// Whether a call of this function type lets the caller name what comes back:
// a signature with type parameters of its own whose return launders
// (`<T>(s: string) => T`, `<T>(s: string) => Promise<T[]>`).
export function genericReturn(checker: ts.TypeChecker, type: ts.Type): boolean {
  return members(type).some((m) =>
    checker.getSignaturesOfType(m, ts.SignatureKind.Call).some((sig) =>
      (sig.typeParameters?.length ?? 0) > 0
      && cachedLaunderingReturn(checker, checker.getReturnTypeOfSignature(sig))));
}

// Whether `any` is the type or sits in a union, intersection or type
// argument of it: what `JSON.parse` returns, which fits any `T`.
function holdsAny(
  checker: ts.TypeChecker, type: ts.Type, seen = new Set<ts.Type>(),
): boolean {
  if (seen.has(type)) return false;
  seen.add(type);
  if (type.flags & ts.TypeFlags.Any) return true;
  if (type.isUnionOrIntersection()) {
    return type.types.some((m) => holdsAny(checker, m, seen));
  }
  return isReference(type)
    && checker.getTypeArguments(type).some((a) => holdsAny(checker, a, seen));
}

// Whether a value of this type is, or returns, `any` somewhere, so that
// assigning it to `<T>(s: string) => T` is accepted for any `T`.
export function anyReturning(checker: ts.TypeChecker, type: ts.Type): boolean {
  return holdsAny(checker, type) || members(type).some((m) =>
    checker.getSignaturesOfType(m, ts.SignatureKind.Call).some((sig) =>
      holdsAny(checker, checker.getReturnTypeOfSignature(sig))));
}

// Whether a declaration sits in the TypeScript lib or a dependency.
export const inForeignFile = (decl: ts.Declaration): boolean => {
  const f = decl.getSourceFile();
  return f.hasNoDefaultLib || f.isDeclarationFile
    && /node_modules|typescript\/lib/.test(f.fileName);
};