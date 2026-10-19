// Drives the real flat ESLint config (web/eslint.config.js) over the
// eslint-fixtures with `ignore: false` (the fixtures are globally ignored so
// `pnpm lint` never trips on their intentional violations). Each bad fixture
// must report its named rule; each corrected variant must be diagnostic-free.
// This is the executable proof that the config enforces exactly the rules the
// task promises -- not that some broader recommended set happens to fire.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";
import {
  isMintSite,
  isTestCode,
  pathMatcher,
  repoPath,
} from "./eslint-plugin-brands/index.mjs";

const toolingDir = dirname(fileURLToPath(import.meta.url));
const webRoot = dirname(toolingDir);
const fixturesDir = join(toolingDir, "eslint-fixtures");

function makeLinter(): ESLint {
  // cwd = web root so eslint.config.js is discovered; ignore:false so the
  // globally-ignored fixtures are actually linted.
  return new ESLint({ cwd: webRoot, ignore: false });
}

interface FixtureCase {
  file: string;
  rule: string;
  corrected: string;
  // Exact number of diagnostics the bad fixture reports for `rule`, when
  // the fixture carries several cases of it.
  count?: number;
}

const cases: readonly FixtureCase[] = [
  {
    file: "missing-hook-dependency.tsx",
    rule: "react-hooks/exhaustive-deps",
    corrected:
      'import { useEffect, useState } from "react";\n' +
      "export function Counter({ start }: { start: number }) {\n" +
      "  const [count, setCount] = useState(start);\n" +
      "  useEffect(() => {\n" +
      "    setCount(start);\n" +
      "  }, [start]);\n" +
      "  return <span>{count}</span>;\n" +
      "}\n",
  },
  {
    file: "floating-promise.ts",
    rule: "@typescript-eslint/no-floating-promises",
    corrected:
      "async function persist(): Promise<void> {}\n" +
      "export function run(): void {\n" +
      "  void persist();\n" +
      "}\n",
  },
  {
    file: "misused-promise.tsx",
    rule: "@typescript-eslint/no-misused-promises",
    corrected:
      "async function save(): Promise<void> {}\n" +
      "export function SaveButton() {\n" +
      "  return <button onClick={() => void save()}>Save</button>;\n" +
      "}\n",
  },
  {
    file: "string-throw.ts",
    rule: "@typescript-eslint/only-throw-error",
    corrected:
      "export function boom(): void {\n" +
      '  throw new Error("boom");\n' +
      "}\n",
  },
  {
    file: "unsafe-catch.ts",
    rule: "@typescript-eslint/use-unknown-in-catch-callback-variable",
    corrected:
      "export function run(p: Promise<number>): void {\n" +
      "  p.then((n) => n).catch((err: unknown) => {\n" +
      "    console.log(err);\n" +
      "  });\n" +
      "}\n",
  },
  {
    file: "restricted-api-fetch.ts",
    rule: "no-restricted-imports",
    corrected:
      'import { apiGet } from "../../src/api/typedClient";\n' +
      "export function load() {\n" +
      '  return apiGet("/api/current-work");\n' +
      "}\n",
  },
  {
    file: "explicit-any.ts",
    rule: "@typescript-eslint/no-explicit-any",
    corrected:
      "export function show(value: unknown): string {\n" +
      "  return String(value);\n" +
      "}\n",
  },
  {
    file: "unsafe-assignment.ts",
    rule: "@typescript-eslint/no-unsafe-assignment",
    corrected:
      "export function isNull(s: string): boolean {\n" +
      "  const v: unknown = JSON.parse(s);\n" +
      "  return v === null;\n" +
      "}\n",
  },
  {
    file: "unsafe-member-access.ts",
    rule: "@typescript-eslint/no-unsafe-member-access",
    corrected:
      "export function idOf(s: string): unknown {\n" +
      "  const v: unknown = JSON.parse(s);\n" +
      '  if (typeof v === "object" && v !== null && "id" in v) return v.id;\n' +
      "  return undefined;\n" +
      "}\n",
  },
  {
    file: "unsafe-return.ts",
    rule: "@typescript-eslint/no-unsafe-return",
    corrected:
      "export function load(s: string): string[] {\n" +
      "  const v: unknown = JSON.parse(s);\n" +
      "  if (!Array.isArray(v)) return [];\n" +
      '  return v.filter((x): x is string => typeof x === "string");\n' +
      "}\n",
  },
  {
    file: "unsafe-argument.ts",
    rule: "@typescript-eslint/no-unsafe-argument",
    corrected:
      "function take(n: number): number {\n" +
      "  return n;\n" +
      "}\n" +
      "export function run(s: string): number {\n" +
      "  const v: unknown = JSON.parse(s);\n" +
      '  return typeof v === "number" ? take(v) : 0;\n' +
      "}\n",
  },
  {
    file: "unsafe-call.ts",
    rule: "@typescript-eslint/no-unsafe-call",
    corrected:
      "export function run(s: string): unknown {\n" +
      "  const v: unknown = JSON.parse(s);\n" +
      '  return typeof v === "function" ? v.name : undefined;\n' +
      "}\n",
  },
  {
    file: "brand-name.ts",
    rule: "brands/name-carries-brand",
    count: 2,
    corrected:
      'import type { BlockUid, PageId } from "../../src/api/brands";\n' +
      "export function lookup(uid: BlockUid): BlockUid {\n" +
      "  return uid;\n" +
      "}\n" +
      "export interface Row {\n" +
      "  pageId: PageId;\n" +
      "}\n",
  },
  {
    file: "brand-assertion.ts",
    rule: "brands/no-brand-assertion",
    count: 3,
    corrected:
      'import type { BlockUid } from "../../src/api/brands";\n' +
      'import { parseBlockUid } from "../../src/ids";\n' +
      "export function direct(x: string): BlockUid | null {\n" +
      "  return parseBlockUid(x);\n" +
      "}\n",
  },
  {
    file: "brand-assertion-structural.ts",
    rule: "brands/no-brand-assertion",
    count: 2,
    corrected:
      'import type { BatchId, BlockUid } from "../../src/api/brands";\n' +
      "interface PendingOp {\n" +
      "  batch_id: BatchId;\n" +
      "}\n" +
      "export function rowsOf(rows: { uid: BlockUid }[]): BlockUid[] {\n" +
      "  return rows.map((r) => r.uid);\n" +
      "}\n" +
      "export function opOf(s: string): unknown {\n" +
      "  const v: unknown = JSON.parse(s);\n" +
      "  return v;\n" +
      "}\n",
  },
  {
    file: "brand-opt-out-outside-boundary.ts",
    rule: "brands/name-carries-brand",
    count: 1,
    corrected:
      'import type { BlockUid } from "../../src/api/brands";\n' +
      "export function lookup(uid: BlockUid): BlockUid {\n" +
      "  return uid;\n" +
      "}\n",
  },
  {
    file: "brand-assertion-mapped.ts",
    rule: "brands/no-brand-assertion",
    count: 8,
    corrected:
      'import type { BlockUid } from "../../src/api/brands";\n' +
      "export function keep(v: Record<string, BlockUid>): unknown {\n" +
      "  return v;\n" +
      "}\n",
  },
  {
    file: "brand-name-shallow.ts",
    rule: "brands/name-carries-brand",
    count: 5,
    corrected:
      'import type { BlockUid } from "../../src/api/brands";\n' +
      "export function a(uid: BlockUid | null): void {\n" +
      "  void uid;\n" +
      "}\n" +
      "export function b(uids: readonly BlockUid[]): void {\n" +
      "  void uids;\n" +
      "}\n" +
      "export function c(uids: BlockUid[] | undefined): void {\n" +
      "  void uids;\n" +
      "}\n" +
      "export function d(uids: ReadonlySet<BlockUid>): void {\n" +
      "  void uids;\n" +
      "}\n" +
      "export function e(uid: Map<BlockUid, string>): void {\n" +
      "  void uid;\n" +
      "}\n" +
      "export function f(uid: Record<BlockUid, string>): void {\n" +
      "  void uid;\n" +
      "}\n",
  },
  {
    file: "brand-assertion-generic.ts",
    rule: "brands/no-brand-assertion",
    count: 4,
    corrected:
      'import type { BlockUid, PageId } from "../../src/api/brands";\n' +
      "export function pick<T extends BlockUid | PageId>(x: T): T {\n" +
      "  return x;\n" +
      "}\n",
  },
  {
    file: "brand-predicate.ts",
    rule: "brands/no-brand-assertion",
    count: 4,
    corrected:
      'import type { BlockUid } from "../../src/api/brands";\n' +
      'import { parseBlockUid } from "../../src/ids";\n' +
      "export function parse(x: string): BlockUid | null {\n" +
      "  return parseBlockUid(x);\n" +
      "}\n",
  },
  {
    file: "brand-predicate-launder.ts",
    rule: "brands/no-brand-assertion",
    count: 22,
    corrected:
      'import type { BlockUid } from "../../src/api/brands";\n' +
      'type Op = { op: "insert"; uid: BlockUid } | { op: "note"; n: 1 };\n' +
      "export function present(x: BlockUid | null): x is BlockUid {\n" +
      "  return x !== null;\n" +
      "}\n" +
      "export function assertPresent(\n" +
      "  x: BlockUid | undefined,\n" +
      "): asserts x is BlockUid {\n" +
      "  void x;\n" +
      "}\n" +
      "export function isInsert(\n" +
      "  x: Op,\n" +
      '): x is { op: "insert"; uid: BlockUid } {\n' +
      '  return x.op === "insert";\n' +
      "}\n" +
      "export function levelled(\n" +
      "  x: { uid: BlockUid; level: number | null },\n" +
      "): x is { uid: BlockUid; level: number } {\n" +
      "  return x.level !== null;\n" +
      "}\n" +
      "export function listed(x: BlockUid[] | null): x is BlockUid[] {\n" +
      "  return x !== null;\n" +
      "}\n" +
      "export function mutable(x: readonly BlockUid[]): x is BlockUid[] {\n" +
      "  return Array.isArray(x);\n" +
      "}\n" +
      "export function notText(\n" +
      "  x: string | { uid: BlockUid },\n" +
      "): x is { uid: BlockUid } {\n" +
      '  return typeof x !== "string";\n' +
      "}\n" +
      "export function many(x: string | BlockUid[]): x is BlockUid[] {\n" +
      "  return Array.isArray(x);\n" +
      "}\n" +
      "export class Index<K, V> extends Map<K, V> {\n" +
      "  tag = 1;\n" +
      "}\n" +
      "export function isIndex(\n" +
      "  x: Map<BlockUid, number> | null,\n" +
      "): x is Index<BlockUid, number> {\n" +
      "  return x instanceof Index;\n" +
      "}\n" +
      "export class Sorted<K, V> extends Index<K, V> {\n" +
      "  sorted = true;\n" +
      "}\n" +
      "export function isSorted(\n" +
      "  x: Map<BlockUid, number> | null,\n" +
      "): x is Sorted<BlockUid, number> {\n" +
      "  return x instanceof Sorted;\n" +
      "}\n" +
      "export function isReadIndex(\n" +
      "  x: ReadonlyMap<BlockUid, number> | null,\n" +
      "): x is Index<BlockUid, number> {\n" +
      "  return x instanceof Index;\n" +
      "}\n" +
      "export function counted(\n" +
      "  x: { uid: BlockUid },\n" +
      "): x is { uid: BlockUid; n?: number } {\n" +
      "  return \"n\" in x;\n" +
      "}\n" +
      "export function notNull<T>(x: T | null | undefined): x is T {\n" +
      "  return x != null;\n" +
      "}\n" +
      "export function isDefined<T>(x: T): x is NonNullable<T> {\n" +
      "  return x != null;\n" +
      "}\n" +
      "export function compact<T>(xs: readonly (T | null)[]): T[] {\n" +
      "  return xs.filter((x): x is T => x !== null);\n" +
      "}\n" +
      "export function assertPresentOf<T>(x: T | undefined): asserts x is T {\n" +
      "  if (x === undefined) throw new Error(\"absent\");\n" +
      "}\n",
  },
  {
    file: "brand-overload.ts",
    rule: "brands/no-brand-assertion",
    count: 18,
    corrected:
      'import type { BlockUid } from "../../src/api/brands";\n' +
      "export function same(x: BlockUid): BlockUid;\n" +
      "export function same(x: null): null;\n" +
      "export function same(x: BlockUid | null): BlockUid | null {\n" +
      "  return x;\n" +
      "}\n" +
      "export class Keeper {\n" +
      "  keep(x: BlockUid): BlockUid;\n" +
      "  keep(x: BlockUid | null): BlockUid | null {\n" +
      "    return x;\n" +
      "  }\n" +
      "}\n" +
      "export class Index<K, V> extends Map<K, V> {\n" +
      "  tag = 1;\n" +
      "}\n" +
      "export function indexOf(m: Map<BlockUid, number>): Index<BlockUid, number>;\n" +
      "export function indexOf(m: Map<BlockUid, number>): Map<BlockUid, number> {\n" +
      "  return m;\n" +
      "}\n" +
      "export function tagged(x: BlockUid): Promise<BlockUid> & { t: 1 };\n" +
      "export function tagged(x: BlockUid): Promise<BlockUid> & { t: 1 } {\n" +
      "  return Object.assign(Promise.resolve(x), { t: 1 as const });\n" +
      "}\n" +
      "export function first<T>(xs: readonly T[]): T | undefined {\n" +
      "  return xs[0];\n" +
      "}\n" +
      "export function pick<T>(x: T, label?: string): T {\n" +
      "  void label;\n" +
      "  return x;\n" +
      "}\n" +
      "export function firstOf<T>(xs: readonly T[]): T | undefined {\n" +
      "  return xs[0];\n" +
      "}\n",
  },
  {
    file: "brand-assertion-launder.ts",
    rule: "brands/no-brand-assertion",
    count: 19,
    corrected:
      'import type { BlockUid, PageId } from "../../src/api/brands";\n' +
      "export function pick<T extends BlockUid | PageId>(x: T): T {\n" +
      "  return x;\n" +
      "}\n" +
      'export function mode(k: string): "a" | "b" | null {\n' +
      '  return k === "a" || k === "b" ? k : null;\n' +
      "}\n" +
      'export const modes = ["a", "b"] as const;\n' +
      "export function frozen<T>(xs: T[]): readonly T[] {\n" +
      "  const ys: readonly T[] = xs;\n" +
      "  return ys;\n" +
      "}\n" +
      "export function none<T>(): T[] {\n" +
      "  const xs: T[] = [];\n" +
      "  return xs;\n" +
      "}\n" +
      "interface Shape {\n" +
      "  a: number;\n" +
      "  b: string;\n" +
      "}\n" +
      "export const field = (f: string) => f as keyof Shape;\n",
  },
  {
    file: "brand-assertion-optional.ts",
    rule: "brands/no-brand-assertion",
    count: 14,
    corrected:
      'import type { BlockUid } from "../../src/api/brands";\n' +
      "export function frozen(xs: BlockUid[]): readonly BlockUid[] {\n" +
      "  const ys: readonly BlockUid[] = xs;\n" +
      "  return ys;\n" +
      "}\n" +
      "export function maybe<T>(x: T): T | undefined {\n" +
      "  const y: T | undefined = x;\n" +
      "  return y;\n" +
      "}\n" +
      "export const none = (): BlockUid[] => [];\n" +
      "export function counts(): Record<BlockUid, number> {\n" +
      "  const r: Record<BlockUid, number> = {};\n" +
      "  return r;\n" +
      "}\n" +
      "export function start<T>(): Partial<T> {\n" +
      "  const p: Partial<T> = {};\n" +
      "  return p;\n" +
      "}\n" +
      "interface Row {\n" +
      "  uid: BlockUid;\n" +
      "  n: number;\n" +
      "}\n" +
      "export function picked<K extends keyof Row>(r: Row): Pick<Row, K> {\n" +
      "  const p: Pick<Row, K> = r;\n" +
      "  return p;\n" +
      "}\n" +
      "export function frozenPartial<T>(t: T): Partial<Readonly<T>> {\n" +
      "  const p: Partial<Readonly<T>> = t;\n" +
      "  return p;\n" +
      "}\n" +
      "export function narrower<T, U extends T>(u: U): Partial<T> {\n" +
      "  const p: Partial<T> = u;\n" +
      "  return p;\n" +
      "}\n" +
      "export function numbered(\n" +
      "  x: Record<string, BlockUid>,\n" +
      "): { [i: number]: BlockUid } {\n" +
      "  const n: { [i: number]: BlockUid } = x;\n" +
      "  return n;\n" +
      "}\n",
  },
  {
    file: "brand-name-positions.ts",
    rule: "brands/name-carries-brand",
    count: 7,
    corrected:
      'import type { BlockUid } from "../../src/api/brands";\n' +
      "export type Handler = (uid: BlockUid) => void;\n" +
      "export class Holder {\n" +
      "  constructor(private readonly uid: BlockUid) {}\n" +
      "}\n" +
      "export function rest(...uids: BlockUid[]): void {\n" +
      "  void uids;\n" +
      "}\n",
  },
  {
    file: "brand-bypass.ts",
    rule: "brands/no-brand-bypass",
    count: 23,
    corrected:
      'import type { BlockUid } from "../../src/api/brands";\n' +
      "export function call(f: (uid: BlockUid) => void, uid: BlockUid): void {\n" +
      "  f(uid);\n" +
      "  f.call(undefined, uid);\n" +
      "}\n" +
      "interface Row {\n  uid: BlockUid;\n  text: string;\n}\n" +
      "export function write(row: Row): void {\n" +
      '  Object.assign(row, { text: "t" });\n' +
      '  Object.defineProperty(row, "text", { value: "t" });\n' +
      '  Object.defineProperties(row, { text: { value: "t" } });\n' +
      "}\n" +
      "export function dynamic(o: object, key: string): void {\n" +
      "  Object.defineProperty(o, key, { value: 1 });\n" +
      "}\n" +
      "export function branded(row: Row, uid: BlockUid, other: Row): void {\n" +
      "  Object.assign(row, { uid });\n" +
      "  Object.assign({}, other);\n" +
      "  Object.defineProperty(row, \"uid\", { value: uid });\n" +
      "  Reflect.set(row, \"uid\", uid);\n" +
      "}\n" +
      "export const sameKind = (x: unknown) => x instanceof Object;\n",
  },
  {
    file: "restricted-test-code-import.ts",
    rule: "no-restricted-imports",
    count: 2,
    corrected:
      'import { apiGet } from "../../src/api/typedClient";\n' +
      "export const load = () => apiGet(\"/api/current-work\");\n",
  },
  {
    file: "restricted-test-code-import.ts",
    rule: "no-restricted-syntax",
    count: 3,
    corrected:
      'export const load = () => import("../../src/api/typedClient");\n' +
      "export const named = (name: string) => import(`../../src/${name}`);\n",
  },
];

// Each ESLint spawn here takes ~2s under coverage instrumentation, close
// enough to the 5s default that this file flaked repeatedly during parallel
// verify runs. An explicit timeout gives it real headroom.
const ESLINT_TIMEOUT_MS = 20000;

describe("eslint flat config", () => {
  it("each bad fixture reports its named rule", async () => {
    const linter = makeLinter();
    for (const c of cases) {
      const results = await linter.lintFiles([join(fixturesDir, c.file)]);
      const ruleIds = results.flatMap((r) => r.messages.map((m) => m.ruleId));
      expect(ruleIds, `${c.file} messages: ${JSON.stringify(ruleIds)}`)
        .toContain(c.rule);
      if (c.count !== undefined) {
        expect(ruleIds.filter((id) => id === c.rule), c.file)
          .toHaveLength(c.count);
      }
    }
  }, ESLINT_TIMEOUT_MS);

  it("each corrected variant is diagnostic-free", async () => {
    const linter = makeLinter();
    for (const c of cases) {
      const results = await linter.lintText(c.corrected, {
        filePath: join(fixturesDir, c.file),
      });
      const messages = results.flatMap((r) => r.messages);
      expect(messages, `${c.file} messages: ${JSON.stringify(messages)}`)
        .toHaveLength(0);
    }
  }, ESLINT_TIMEOUT_MS);
});

describe("brands plugin paths", () => {
  const violating =
    'import type { BlockUid } from "../api/brands";\n' +
    "export function f(uid: string, x: string): BlockUid {\n" +
    "  void uid;\n" +
    "  return x as BlockUid;\n" +
    "}\n";
  const brandIds = async (rel: string): Promise<string[]> => {
    const results = await makeLinter().lintText(violating, {
      filePath: join(webRoot, rel),
    });
    return results
      .flatMap((r) => r.messages.map((m) => m.ruleId ?? ""))
      .filter((id) => id.startsWith("brands/"));
  };

  it("reports the violating text in a production file", async () => {
    expect(await brandIds("src/sync/opQueue.ts")).toEqual([
      "brands/name-carries-brand",
      "brands/no-brand-assertion",
    ]);
  }, ESLINT_TIMEOUT_MS);

  it("lints test files and test support like production", async () => {
    const both = ["brands/name-carries-brand", "brands/no-brand-assertion"];
    expect(await brandIds("src/sync/memReplica.ts")).toEqual(both);
    expect(await brandIds("src/replica/replayArbs.ts")).toEqual(both);
    expect(await brandIds("src/sync/listeners.test.ts")).toEqual(both);
  }, ESLINT_TIMEOUT_MS);

  it("normalises absolute paths against the repo root", () => {
    const abs = (rel: string): string => join(webRoot, rel);
    expect(repoPath(abs("src/ids.ts"))).toBe("web/src/ids.ts");
    expect(isTestCode(repoPath(abs("src/props/ops/compare.ts")))).toBe(true);
    expect(isTestCode(repoPath(abs("src/paths.test.ts")))).toBe(true);
    expect(isTestCode(repoPath(abs("src/test-setup.ts")))).toBe(true);
    expect(isTestCode(repoPath(abs("tooling/perf/x.ts")))).toBe(false);
    expect(isTestCode(repoPath(abs("src/ids.ts")))).toBe(false);
  });

  it("matches mint sites per brand only", () => {
    expect(isMintSite("BlockUid", "server/src/pkm/planning.py")).toBe(true);
    expect(isMintSite("SyncSeq", "server/src/pkm/planning.py")).toBe(false);
    expect(isMintSite("SyncSeq", "server/src/pkm/contracts/x.py"))
      .toBe(true);
  });

  it("makes the test mint module a mint site for every brand", () => {
    expect(isMintSite("SyncSeq", "web/src/test-helpers.ts")).toBe(true);
    expect(isMintSite("ParkedTitle", "web/src/test-helpers.ts")).toBe(true);
    expect(isMintSite("SyncSeq", "web/src/props/ops/compare.ts")).toBe(false);
  });

  it("globs: **/ is zero or more directories", () => {
    const m = pathMatcher("web/src/**/x.ts");
    expect(m("web/src/x.ts")).toBe(true);
    expect(m("web/src/a/b/x.ts")).toBe(true);
    expect(m("web/src/a/xx.ts")).toBe(false);
  });

  it("globs: ** crosses directories, * does not", () => {
    const m = pathMatcher("a/**/routes_*.py");
    expect(m("a/b/c/routes_x.py")).toBe(true);
    expect(m("a/b/routes_x/y.py")).toBe(false);
  });
});

describe("brands plugin judgement", () => {
  const messagesFor = async (
    rel: string, text: string,
  ): Promise<{ ruleId: string; message: string }[]> => {
    const results = await makeLinter().lintText(text, {
      filePath: join(webRoot, rel),
    });
    return results
      .flatMap((r) => r.messages)
      .filter((m) => m.ruleId?.startsWith("brands/"))
      .map((m) => ({ ruleId: m.ruleId ?? "", message: m.message }));
  };

  it("governs a subtype brand by its own mint sites", async () => {
    const text =
      'import type { CanonicalTitle } from "../api/brands";\n' +
      "export const t = (s: string) => s as CanonicalTitle;\n";
    // scan.ts mints NormalizedTitle, not its CanonicalTitle subtype.
    const inScan = await messagesFor("src/grammar/scan.ts", text);
    expect(inScan.map((m) => m.ruleId)).toEqual(["brands/no-brand-assertion"]);
    expect(inScan[0].message).toContain("CanonicalTitle");
    expect(inScan[0].message).not.toContain("NormalizedTitle");
    expect(await messagesFor("src/replica/daily.ts", text)).toEqual([]);
  }, ESLINT_TIMEOUT_MS);

  it("names the parser and the mint module in the remedy", async () => {
    const text =
      'import type { BlockUid } from "../api/brands";\n' +
      "export const f = (s: string) => s as BlockUid;\n" +
      "export function g(uids: string[]): void {\n" +
      "  void uids;\n" +
      "}\n";
    const found = await messagesFor("src/sync/opQueue.ts", text);
    expect(found).toHaveLength(2);
    expect(found[0].message).toContain("parseBlockUid");
    expect(found[0].message).toContain("web/src/ids.ts");
    expect(found[1].message).toContain("`BlockUid[]`");
  }, ESLINT_TIMEOUT_MS);

  it("honours an opt-out line on a laundering assertion in a boundary", async () => {
    const text =
      "export function f<T>(x: unknown): T {\n" +
      "  // brand: untrusted -- a response body\n" +
      "  return x as T;\n" +
      "}\n";
    expect(await messagesFor("src/api/client.ts", text)).toEqual([]);
    const outside = await messagesFor("src/sync/opQueue.ts", text);
    expect(outside.map((m) => m.ruleId)).toEqual(["brands/no-brand-assertion"]);
    expect(outside[0].message).toContain("launders");
  }, ESLINT_TIMEOUT_MS);

  it("lets a predicate narrow a brand its parameter already carries", async () => {
    const text =
      'import type { BlockUid } from "../api/brands";\n' +
      "type Op = { uid: BlockUid; n: 1 } | { n: 2 };\n" +
      "export const hasUid = (op: Op): op is { uid: BlockUid; n: 1 } =>\n" +
      "  op.n === 1;\n" +
      "export function over(op: Op): op is Op;\n" +
      "export function over(op: Op): boolean {\n" +
      "  return op.n === 1;\n" +
      "}\n";
    expect(await messagesFor("src/sync/opQueue.ts", text)).toEqual([]);
  }, ESLINT_TIMEOUT_MS);

  it("honours an opt-out line on a constrained launder in a boundary", async () => {
    const text =
      "export function f<T extends string>(x: string): T {\n" +
      "  // brand: untrusted -- a response body\n" +
      "  return x as T;\n" +
      "}\n";
    expect(await messagesFor("src/api/client.ts", text)).toEqual([]);
    const outside = await messagesFor("src/sync/opQueue.ts", text);
    expect(outside.map((m) => m.ruleId)).toEqual(["brands/no-brand-assertion"]);
    expect(outside[0].message).toContain("launders");
  }, ESLINT_TIMEOUT_MS);

  it("launders through an object constraint even in a mint site", async () => {
    const text =
      'import type { BlockUid } from "./api/brands";\n' +
      "export function row<T extends { uid: BlockUid; text: string }>(\n" +
      "  x: unknown,\n" +
      "): T {\n" +
      "  return x as T;\n" +
      "}\n";
    const found = await messagesFor("src/ids.ts", text);
    expect(found.map((m) => m.ruleId)).toEqual(["brands/no-brand-assertion"]);
    expect(found[0].message).toContain("launders");
  }, ESLINT_TIMEOUT_MS);

  it("reports an assertion toward a brand whatever its operand", async () => {
    const text =
      'import type { BlockUid } from "../api/brands";\n' +
      "export const keep = (u: BlockUid): BlockUid | null => u;\n" +
      "export const widen = (u: BlockUid) => u as BlockUid | null;\n" +
      "export const wide = (v: unknown) => JSON.parse(String(v)) as BlockUid;\n";
    const found = await messagesFor("src/sync/opQueue.ts", text);
    expect(found.map((m) => m.message.includes("BlockUid"))).toEqual([true, true]);
  }, ESLINT_TIMEOUT_MS);

  it("lets an overload add a brand in its mint site only", async () => {
    const text =
      'import type { BlockUid } from "../api/brands";\n' +
      "export function p(s: string): BlockUid;\n" +
      "export function p(s: string): string {\n" +
      "  return s;\n" +
      "}\n";
    expect(await messagesFor("src/ids.ts", text)).toEqual([]);
    const outside = await messagesFor("src/sync/opQueue.ts", text);
    expect(outside.map((m) => m.ruleId)).toEqual(["brands/no-brand-assertion"]);
    expect(outside[0].message).toContain("implementation");
  }, ESLINT_TIMEOUT_MS);

  it("walks a Pick alias by its picked keys, not every key", async () => {
    const head =
      'import type { Columns } from "../replica/columns.gen";\n';
    const clean = await messagesFor("src/sync/opQueue.ts",
      head + 'export const f = (v: unknown) => v as Pick<Columns, "n">;\n');
    expect(clean).toEqual([]);
    const picked = await messagesFor("src/sync/opQueue.ts",
      head + 'export const f = (v: unknown) => v as Pick<Columns, "uid">;\n');
    expect(picked).toHaveLength(1);
    expect(picked[0].message).toContain("BlockUid");
    expect(picked[0].message).not.toContain("PageId");
  }, ESLINT_TIMEOUT_MS);

  it("asks for a reason when an opt-out file's marker has none", async () => {
    const text =
      "// brand: untrusted\n" +
      "export function f(uid: string): string {\n" +
      "  return uid;\n" +
      "}\n";
    const found = await messagesFor("tooling/viteBudgetPlugin.ts", text);
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain("add a reason");
  }, ESLINT_TIMEOUT_MS);
});

describe("tests under the lint", () => {
  // Each path is a real file: the project service parses only files the
  // tsconfig includes, and lintText stands the text in for the file's own.
  const messagesFor = async (
    rel: string, text: string,
  ): Promise<{ ruleId: string; message: string }[]> => {
    const results = await makeLinter().lintText(text, {
      filePath: join(webRoot, rel),
    });
    return results
      .flatMap((r) => r.messages)
      .map((m) => ({ ruleId: m.ruleId ?? "", message: m.message }));
  };
  const rulesOf = (found: { ruleId: string }[]): string[] =>
    found.map((m) => m.ruleId);

  it("a test file is linted by the brand rules", async () => {
    const found = await messagesFor("src/paths.test.ts",
      'import type { BlockUid } from "./api/brands";\n'
      + 'export const u = "x" as BlockUid;\n');
    expect(rulesOf(found)).toEqual(["brands/no-brand-assertion"]);
    expect(found[0].message).toContain("uidOf");
    expect(found[0].message).toContain("test-helpers");
  }, ESLINT_TIMEOUT_MS);

  it("names the helper for a name that means a brand in a test", async () => {
    const found = await messagesFor("src/paths.test.ts",
      "export function f(pageId: number): number {\n"
      + "  return pageId;\n"
      + "}\n");
    expect(rulesOf(found)).toEqual(["brands/name-carries-brand"]);
    expect(found[0].message).toContain("pageIdOf");
  }, ESLINT_TIMEOUT_MS);

  it("test-helpers.ts may mint every brand", async () => {
    // `up` leads from the linted file to src/.
    const text = (up: string): string =>
      `import type { BlockUid, PageId, Sha256Hex, SyncSeq } from "${up}api/brands";\n`
      + `import type { PendingRowId } from "${up}replica/client";\n`
      + `import type { RequestId } from "${up}outline/outlineState";\n`
      + "export const a = (s: string) => s as BlockUid;\n"
      + "export const b = (n: number) => n as PageId;\n"
      + "export const c = (s: string) => s as Sha256Hex;\n"
      + "export const d = (n: number) => n as SyncSeq;\n"
      + "export const e = (n: number) => n as PendingRowId;\n"
      + "export const f = (n: number) => n as RequestId;\n";
    expect(await messagesFor("src/test-helpers.ts", text("./"))).toEqual([]);
    const outside = await messagesFor("src/props/ops/compare.ts", text("../../"));
    expect(rulesOf(outside)).toEqual(
      Array<string>(6).fill("brands/no-brand-assertion"));
  }, ESLINT_TIMEOUT_MS);

  it("props files are linted", async () => {
    const found = await messagesFor("src/props/ops/compare.ts",
      'import type { PageId } from "../../api/brands";\n'
      + "export const p = (n: number) => n as PageId;\n");
    expect(rulesOf(found)).toEqual(["brands/no-brand-assertion"]);
    expect(found[0].message).toContain("pageIdOf");
  }, ESLINT_TIMEOUT_MS);

  it("product code may not import the test helpers", async () => {
    const imports = [
      'import { uidOf } from "../test-helpers";\nvoid uidOf;\n',
      'import { uidOf } from "./test-helpers.ts";\nvoid uidOf;\n',
      'import { uidOf } from "../test-helpers.js";\nvoid uidOf;\n',
      'export const load = () => import("../test-helpers");\n',
    ];
    const bans = new Set(["no-restricted-imports", "no-restricted-syntax"]);
    const restricted = async (rel: string): Promise<string[]> => {
      const found: string[] = [];
      for (const text of imports) {
        const messages = await messagesFor(rel, text);
        for (const m of messages) {
          if (bans.has(m.ruleId)) found.push(m.message);
        }
      }
      return found;
    };
    // SyncProvider.tsx is a transport boundary: it may import apiFetch,
    // and still not the test helpers.
    for (const rel of ["src/outline/tree.ts", "src/sync/SyncProvider.tsx"]) {
      const product = await restricted(rel);
      expect(product, rel).toHaveLength(imports.length);
      for (const message of product) {
        expect(message, rel).toContain("test helpers mint brands without a parse");
      }
    }
    expect(await restricted("src/outline/tree.test.ts")).toEqual([]);
    expect(await restricted("src/props/ops/example.ts")).toEqual([]);
    expect(await restricted("src/replica/testDb.ts")).toEqual([]);
  }, ESLINT_TIMEOUT_MS);

  it("product code may not import the test fixtures, tests may", async () => {
    const imports = [
      'import { openTestDb } from "../replica/testDb";\nvoid openTestDb;\n',
      'import { memReplica } from "./memReplica.ts";\nvoid memReplica;\n',
      'export const a = () => import("../replica/testDb");\n',
      "export const b = () => import(`../sync/${'x'}memReplica`);\n",
    ];
    for (const rel of ["src/outline/tree.ts", "src/sync/SyncProvider.tsx"]) {
      for (const text of imports) {
        const found = await messagesFor(rel, text);
        expect(rulesOf(found).filter((r) => r.startsWith("no-restricted")), text)
          .toHaveLength(1);
      }
    }
    for (const text of imports) {
      const found = await messagesFor("src/outline/tree.test.ts", text);
      expect(rulesOf(found).filter((r) => r.startsWith("no-restricted")), text)
        .toEqual([]);
    }
  }, ESLINT_TIMEOUT_MS);

  it("the bypass rule covers tests, where the syntax bans are off", async () => {
    const text =
      'import type { BlockUid } from "./api/brands";\n'
      + "export function f(row: { uid: BlockUid }): void {\n"
      + '  Object.assign(row, { uid: "junk" });\n'
      + "}\n";
    const found = await messagesFor("src/paths.test.ts", text);
    expect(rulesOf(found)).toEqual(["brands/no-brand-bypass"]);
    expect(found[0].message).toContain("uidOf");
    // The test mint module may write any brand-named field.
    expect(await messagesFor("src/test-helpers.ts", text)).toEqual([]);
  }, ESLINT_TIMEOUT_MS);

  it("test files keep the apiFetch import ban", async () => {
    const found = await messagesFor("src/outline/tree.test.ts",
      'import { apiFetch } from "../api/client";\nvoid apiFetch;\n');
    expect(rulesOf(found)).toEqual(["no-restricted-imports"]);
    expect(found[0].message).toContain("apiFetch");
  }, ESLINT_TIMEOUT_MS);

  it("ts-ignore and ts-nocheck are banned, ts-expect-error needs a description", async () => {
    const banned = await messagesFor("src/paths.test.ts",
      "// @ts-nocheck\n"
      + "// @ts-ignore\n"
      + "export const a: number = 1;\n"
      + "// @ts-expect-error\n"
      + "export const b: number = 2;\n");
    expect(rulesOf(banned)).toEqual(
      Array<string>(3).fill("@typescript-eslint/ban-ts-comment"));
    const described = await messagesFor("src/paths.test.ts",
      "// @ts-expect-error -- a string where the type wants a number\n"
      + 'export const c: number = "3";\n');
    expect(described).toEqual([]);
  }, ESLINT_TIMEOUT_MS);

  it("any reaches a branded slot only with a report in tests", async () => {
    const found = await messagesFor("src/paths.test.ts",
      'import type { BlockUid } from "./api/brands";\n'
      + "export function f(s: string): BlockUid {\n"
      + "  const u: BlockUid = JSON.parse(s);\n"
      + "  return u;\n"
      + "}\n");
    expect(rulesOf(found)).toEqual(["@typescript-eslint/no-unsafe-assignment"]);
  }, ESLINT_TIMEOUT_MS);
});
