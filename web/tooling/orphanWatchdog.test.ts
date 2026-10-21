// @vitest-environment node
// Proves src/orphanWatchdog.ts ends a vitest worker whose parent was killed
// while the worker spun in synchronous code: the fixture run starts in its
// own process group, its worker reports its pid and spins, and the parent is
// SIGKILLed. The worker stays in that group after reparenting, so killing
// the group afterwards cleans up whatever the watchdog left.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";

const toolingDir = dirname(fileURLToPath(import.meta.url));
const webRoot = dirname(toolingDir);
const fixturesDir = join(toolingDir, "orphan-watchdog-fixtures");

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const until = async (what: string, ok: () => boolean, ms: number) => {
  const deadline = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => { setTimeout(r, 100); });
  }
};

let group = 0;
let outDir = "";
afterEach(() => {
  if (group !== 0 && alive(-group)) process.kill(-group, "SIGKILL");
  rmSync(outDir, { recursive: true, force: true });
});

it("kills a spinning worker once its vitest parent is gone", async () => {
  outDir = mkdtempSync(join(tmpdir(), "orphan-watchdog-"));
  const pidFile = join(outDir, "worker.pid");
  const parent = spawn(process.execPath, [
    join(webRoot, "node_modules/vitest/vitest.mjs"), "run",
    "--config", join(fixturesDir, "vitest.config.ts"),
  ], {
    cwd: webRoot,
    detached: true,
    stdio: "ignore",
    env: { ...process.env, ORPHAN_PID_FILE: pidFile },
  });
  group = parent.pid ?? 0;
  await until("the worker's pid", () => existsSync(pidFile)
    && readFileSync(pidFile, "utf8") !== "", 30_000);
  const worker = Number(readFileSync(pidFile, "utf8"));
  expect(alive(worker)).toBe(true);

  process.kill(group, "SIGKILL");
  await until("the orphaned worker to die", () => !alive(worker), 10_000);
}, 60_000);
