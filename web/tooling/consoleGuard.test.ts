// Proves src/test-setup.ts's console guard fails a real vitest run: the
// *.guard.ts fixtures (not matched by the default run) go through one
// subprocess under the same setup file, and each file's verdict is read from
// the JSON report.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const toolingDir = dirname(fileURLToPath(import.meta.url));
const webRoot = dirname(toolingDir);
const fixturesDir = join(toolingDir, "console-guard-fixtures");

interface FileReport {
  name: string;
  status: string;
  message: string;
  assertionResults: { status: string; failureMessages: string[] }[];
}

const reports = new Map<string, FileReport>();
let outDir = "";

beforeAll(() => {
  outDir = mkdtempSync(join(tmpdir(), "console-guard-"));
  const outputFile = join(outDir, "report.json");
  spawnSync(process.execPath, [
    join(webRoot, "node_modules/vitest/vitest.mjs"), "run",
    "--config", join(fixturesDir, "vitest.config.ts"),
    "--reporter=json", `--outputFile=${outputFile}`,
  ], { cwd: webRoot, encoding: "utf8" });
  const parsed = JSON.parse(readFileSync(outputFile, "utf8")) as {
    testResults: FileReport[];
  };
  for (const file of parsed.testResults) {
    reports.set(file.name.split("/").pop() ?? file.name, file);
  }
}, 60_000);

afterAll(() => { rmSync(outDir, { recursive: true, force: true }); });

const report = (name: string): FileReport => {
  const file = reports.get(name);
  if (file === undefined) throw new Error(`no report for ${name}`);
  return file;
};
const failures = (file: FileReport): string =>
  [file.message, ...file.assertionResults.flatMap((a) => a.failureMessages)]
    .join("\n");

describe("console guard", () => {
  it("fails a test that calls console.warn", () => {
    const file = report("warns.guard.ts");
    expect(file.assertionResults.map((a) => a.status)).toEqual(["failed"]);
    expect(failures(file)).toContain("console.warn: stray warning");
  });

  it("fails a test that calls console.error", () => {
    const file = report("errors.guard.ts");
    expect(file.assertionResults.map((a) => a.status)).toEqual(["failed"]);
    expect(failures(file)).toContain("console.error: stray error");
  });

  it("fails the file for a log after its last test", () => {
    const file = report("late.guard.ts");
    expect(file.status).toBe("failed");
    expect(failures(file)).toContain("console.error: late log");
  });

  it("lets a test silence an expected warning with a spy", () => {
    expect(report("silenced.guard.ts").status).toBe("passed");
  });

  it("passes a test that logs nothing", () => {
    expect(report("clean.guard.ts").status).toBe("passed");
  });
});
