// pattern: Imperative Shell
import { readFileSync } from "node:fs";
import { dirname, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const toolingDir = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = dirname(dirname(toolingDir));
const REGISTRY_FILE = `${toolingDir}/brandRegistry.gen.json`;

export interface Registry {
  names: Record<string, string[]>;
  mintSites: Record<string, string[]>;
  testMintSites: string[];
  testHelpers: Record<string, string>;
  malformed: Record<string, string>;
  testCode: string[];
  optOutFiles: string[];
}

const fail = (key: string, what: string): never => {
  throw new Error(`${REGISTRY_FILE}: \`${key}\` must be ${what}`);
};
const isStrings = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((s) => typeof s === "string");
const field = (raw: object, key: string): unknown =>
  Object.entries(raw).find(([k]) => k === key)?.[1];
const strings = (raw: object, key: string): string[] => {
  const v = field(raw, key);
  return isStrings(v) ? v : fail(key, "a list of strings");
};
const record = <T>(
  raw: object, key: string, is: (v: unknown) => v is T, what: string,
): Record<string, T> => {
  const v = field(raw, key);
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    return fail(key, `an object of ${what}`);
  }
  const out: Record<string, T> = {};
  for (const [k, item] of Object.entries(v)) {
    out[k] = is(item) ? item : fail(`${key}.${k}`, what);
  }
  return out;
};
const isString = (v: unknown): v is string => typeof v === "string";

// The generated registry, its shape checked once at load.
function parseRegistry(raw: unknown): Registry {
  if (typeof raw !== "object" || raw === null) return fail("", "an object");
  return {
    names: record(raw, "names", isStrings, "lists of strings"),
    mintSites: record(raw, "mintSites", isStrings, "lists of strings"),
    testMintSites: strings(raw, "testMintSites"),
    testHelpers: record(raw, "testHelpers", isString, "strings"),
    malformed: record(raw, "malformed", isString, "strings"),
    testCode: strings(raw, "testCode"),
    optOutFiles: strings(raw, "optOutFiles"),
  };
}

export const registry = parseRegistry(
  JSON.parse(readFileSync(REGISTRY_FILE, "utf8")),
);

// The brands a name means, if the registry lists it; a name every object
// inherits (`toString`, `constructor`) is not listed.
export const brandsNamed = (name: string): string[] | undefined =>
  Object.hasOwn(registry.names, name) ? registry.names[name] : undefined;

export type PathMatcher = (p: string) => boolean;

// A registry path: a trailing "/" is a directory prefix, otherwise a glob
// where `**/` is zero or more directories, a bare `**` crosses directories
// and `*` does not. The server lint's `registry_path_matches` is the same
// rule, and shared/fixtures/registry_paths.json pins the two together.
export function pathMatcher(pattern: string): PathMatcher {
  if (pattern.endsWith("/")) return (p) => p.startsWith(pattern);
  const body = pattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\//g, "\u0001")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0001/g, "(?:.*/)?")
    .replace(/\u0000/g, ".*");
  const re = new RegExp(`^${body}$`);
  return (p) => re.test(p);
}

export const testMintSites = registry.testMintSites.map(pathMatcher);
const testCode = registry.testCode.map(pathMatcher);
export const optOutFiles = registry.optOutFiles.map(pathMatcher);
const mintSites = new Map(
  Object.entries(registry.mintSites).map(
    ([brand, paths]): [string, PathMatcher[]] => [brand, paths.map(pathMatcher)],
  ),
);

// A repo-relative posix path; ESLint hands either an absolute path or one
// relative to the web root.
export function repoPath(filename: string): string {
  const rel = relative(repoRoot, filename);
  return rel.split(sep).join("/");
}

const TEST_FILE = /\.test\.[cm]?[jt]sx?$/;

// A test by name, or by location in the registry's `testCode`.
export function isTestCode(path: string): boolean {
  return TEST_FILE.test(path) || testCode.some((m) => m(path));
}

// The web's test files as flat-config globs, relative to the web root, for
// the config block that lets tests import the test mint module.
export const WEB_PREFIX = "web/";
export const testFileGlobs = [
  "**/*.test.{ts,tsx}",
  ...registry.testCode
    .filter((p) => p.startsWith(WEB_PREFIX))
    .map((p) => p.slice(WEB_PREFIX.length))
    .map((p) => (p.endsWith("/") ? `${p}**` : p)),
];

// The test mint module may mint every brand.
export function isMintSite(brand: string, path: string): boolean {
  return testMintSites.some((m) => m(path))
    || (mintSites.get(brand) ?? []).some((m) => m(path));
}