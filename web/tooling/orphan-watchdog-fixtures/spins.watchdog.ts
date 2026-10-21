import { writeFileSync } from "node:fs";
import { it } from "vitest";

// Synchronous code that never yields, as a filter rejecting every value used
// to: the worker can only be stopped from outside its main thread.
it("spins", () => {
  writeFileSync(process.env.ORPHAN_PID_FILE ?? "", String(process.pid));
  for (;;) { /* never yields */ }
});
