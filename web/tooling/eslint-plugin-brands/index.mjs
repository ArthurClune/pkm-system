// pattern: Imperative Shell
// ESLint rules that keep brands honest on the web, the twin of the server's
// brand rules (docs/architecture/enforced-checks.md#brand-rules):
//   * brands/name-carries-brand: a parameter, property signature or class
//     property whose name means a brand (uid, pageId, sha ...) must be
//     declared with exactly that brand (or null, or an array of it).
//   * brands/no-brand-assertion: `as`/`<T>` toward a type that contains a
//     brand is reported outside the brand's mint sites.
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

const SUBTYPE_KEY = "__canonical";
const SUBTYPE_BRAND = "CanonicalTitle";
const SUBTYPE_PARENT = "NormalizedTitle";

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
      const decls = t.symbol?.declarations ?? [];
      const foreign = decls.length > 0 && decls.every((d) => {
        const f = d.getSourceFile();
        return f.hasNoDefaultLib || f.isDeclarationFile
          && /node_modules|typescript\/lib/.test(f.fileName);
      });
      // A lib mapped type (Partial, Pick, Record ...) takes its properties
      // from the caller's type argument, so it is always walked.
      const mapped = (t.objectFlags & ts.ObjectFlags.Mapped) !== 0;
      if (!foreign || mapped) {
        for (const prop of t.getProperties()) {
          walk(checker.getTypeOfSymbol(prop));
        }
        for (const info of checker.getIndexInfosOfType(t)) walk(info.type);
      }
      t.aliasTypeArguments?.forEach(walk);
    }
  };
  walk(type);
  return found;
}

// The brand literal a type itself carries (not one nested inside it).
function ownBrand(checker, type) {
  const brand = type.getProperty("__brand");
  if (!brand) return null;
  const bt = checker.getTypeOfSymbol(brand);
  return bt.isStringLiteral() ? bt.value : null;
}

// Rule 1's check: the declared type is one of `wanted`, null/undefined, or an
// array/tuple of those, or a union of such. A union with the base type, or a
// brand merely nested in a container or object, does not pass.
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
  return false;
}

function servicesOf(context) {
  const services = context.sourceCode.parserServices;
  if (!services?.program || !services.esTreeNodeToTSNodeMap) {
    throw new Error("brands rules need type information (projectService)");
  }
  return services;
}

// Brand detection is cached per type for the lifetime of a program.
const caches = new WeakMap();
function cachedBrands(checker, type) {
  let cache = caches.get(checker);
  if (!cache) caches.set(checker, cache = new Map());
  let found = cache.get(type);
  if (!found) cache.set(type, found = brandsOf(checker, type));
  return found;
}

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
      const id = param.type === "AssignmentPattern" ? param.left : param;
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
    },
  },
  create(context) {
    const path = repoPath(context.filename);
    if (isExempt(path)) return {};
    const { program, esTreeNodeToTSNodeMap } = servicesOf(context);
    const checker = program.getTypeChecker();
    const check = (node) => {
      const target = node.typeAnnotation;
      if (target.type === "TSTypeReference" && target.typeName.name === "const") {
        return;
      }
      const type = checker.getTypeAtLocation(esTreeNodeToTSNodeMap.get(target));
      const outside = [...cachedBrands(checker, type)].filter(
        (b) => !isMintSite(b, path),
      );
      if (outside.length === 0) return;
      context.report({
        node,
        messageId: "assertion",
        data: {
          brand: outside.join(", "),
          remedy: remedy(outside),
        },
      });
    };
    return { TSAsExpression: check, TSTypeAssertion: check };
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
