// Fails the whole `pnpm e2e` run if the server logged an unhandled
// exception, even though every visible Playwright assertion passed - see
// docs/2026-07-10-implementation-review.md finding 1 and
// server/tests/e2e_serve.py (which writes this file).
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LOG_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".server.log");

export default function globalTeardown(): void {
  if (!existsSync(LOG_PATH)) return;
  const contents = readFileSync(LOG_PATH, "utf-8");
  if (contents.trim().length > 0) {
    throw new Error(
      `e2e server logged an unhandled exception (see ${LOG_PATH}):\n\n${contents}`);
  }
}
