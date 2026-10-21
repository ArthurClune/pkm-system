// Ends a vitest worker whose parent is gone. Killing only the vitest parent
// (an abandoned run, a timeout, an agent's harness) leaves a worker that is
// stuck in synchronous code running: vitest's worker exits on SIGTERM and on
// a closed IPC channel through JS handlers, which never run while the main
// thread spins. A worker thread has its own event loop, so it notices the
// reparenting and SIGKILLs the whole process. proptest's sync_server.py
// watches its parent the same way.
import { Worker } from "node:worker_threads";

const WATCHDOG = `
const { workerData } = require("node:worker_threads");
setInterval(() => {
  if (process.ppid !== workerData.ppid) process.kill(process.pid, "SIGKILL");
}, workerData.pollMs);
`;

// Setup files run once per test file, and one process can run many files.
const started = Symbol.for("pkm.orphanWatchdog");

export function startOrphanWatchdog(pollMs = 1000): void {
  const proc = process as NodeJS.Process & { [started]?: true };
  if (proc[started]) return;
  proc[started] = true;
  new Worker(WATCHDOG, { eval: true, workerData: { ppid: process.ppid, pollMs } })
    .unref();
}
