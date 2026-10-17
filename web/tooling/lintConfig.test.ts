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
  isExempt,
  isMintSite,
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
    count: 4,
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
      "}\n",
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

  it("exempts test-support files", async () => {
    expect(await brandIds("src/sync/memReplica.ts")).toEqual([]);
    expect(await brandIds("src/replica/replayArbs.ts")).toEqual([]);
  }, ESLINT_TIMEOUT_MS);

  it("normalises absolute paths against the repo root", () => {
    const abs = (rel: string): string => join(webRoot, rel);
    expect(repoPath(abs("src/ids.ts"))).toBe("web/src/ids.ts");
    expect(isExempt(repoPath(abs("src/props/ops/a.ts")))).toBe(true);
    expect(isExempt(repoPath(abs("src/foo.test.ts")))).toBe(true);
    expect(isExempt(repoPath(abs("tooling/perf/x.ts")))).toBe(true);
    expect(isExempt(repoPath(abs("src/ids.ts")))).toBe(false);
    expect(isExempt(repoPath(abs("tooling/eslint-fixtures/a.ts"))))
      .toBe(false);
  });

  it("matches mint sites per brand only", () => {
    expect(isMintSite("BlockUid", "server/src/pkm/planning.py")).toBe(true);
    expect(isMintSite("SyncSeq", "server/src/pkm/planning.py")).toBe(false);
    expect(isMintSite("SyncSeq", "server/src/pkm/contracts/x.py"))
      .toBe(true);
  });

  it("globs: ** crosses directories, * does not", () => {
    const m = pathMatcher("a/**/routes_*.py");
    expect(m("a/b/c/routes_x.py")).toBe(true);
    expect(m("a/b/routes_x/y.py")).toBe(false);
  });
});
