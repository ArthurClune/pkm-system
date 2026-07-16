#!/usr/bin/env node
// pattern: Imperative Shell
// Thin wrapper for `pnpm e2e` / the e2e step of `pnpm verify`. Node prints
// "Warning: The 'NO_COLOR' env is ignored due to the 'FORCE_COLOR' env being
// set." in every node process it spawns whenever a caller's shell happens to
// export both -- and it fires before playwright.config.ts is even loaded, so
// fixing it there only cleans up for processes Playwright itself forks
// afterwards (workers, the webServer), not its own CLI process. Node's own
// precedence is FORCE_COLOR, so resolve the conflict here, once, before the
// playwright CLI (and everything in its process tree) ever reads the
// environment.
import { spawnSync } from "node:child_process";

const env = { ...process.env };
if (env.NO_COLOR !== undefined && env.FORCE_COLOR !== undefined) {
  delete env.NO_COLOR;
}

const result = spawnSync(
  "pnpm", ["exec", "playwright", "test", ...process.argv.slice(2)],
  { stdio: "inherit", env },
);
if (result.error) throw result.error;
process.exit(result.status ?? 1);
