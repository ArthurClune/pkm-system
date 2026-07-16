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
];

describe("eslint flat config", () => {
  it("each bad fixture reports its named rule", async () => {
    const linter = makeLinter();
    for (const c of cases) {
      const results = await linter.lintFiles([join(fixturesDir, c.file)]);
      const ruleIds = results.flatMap((r) => r.messages.map((m) => m.ruleId));
      expect(ruleIds, `${c.file} messages: ${JSON.stringify(ruleIds)}`)
        .toContain(c.rule);
    }
  });

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
  });
});
