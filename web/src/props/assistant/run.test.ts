import { describe, expect, test } from "vitest";
import type { StepFn } from "../../assistant/chatMachine";
import type { Action } from "./arbitraries";
import { REAL, runActions, type Tally } from "./run";

const send: Action = { a: "send", blank: false };
const stop: Action = { a: "stop" };
// outcome 0 resolves a create, and is a stream's first event kind (text)
const resolve: Action = { a: "server", pick: 0, outcome: 0 };
const notFound: Action = { a: "server", pick: 0, outcome: 80 };
const confirmEvent: Action = { a: "server", pick: 0, outcome: 4 };

function reached(actions: Action[]): Tally {
  const tally: Tally = new Map();
  expect(runActions(actions, REAL, tally).problems).toEqual([]);
  return tally;
}

// The interleavings the property must reach, run as fixed lists: each passes
// on the real machine and lands the tally entry that names it.
describe("assistant property runner", () => {
  test("send, stop, then the create resolves", () => {
    expect(reached([send, stop, resolve]).get("create resolves after stop")).toBe(1);
  });

  test("send, a 404, stop, then the re-create resolves", () => {
    const tally = reached([send, resolve, notFound, stop, resolve]);
    expect(tally.get("stop while re-creating")).toBe(1);
    expect(tally.get("create resolves after stop while re-creating")).toBe(1);
  });

  test("an answer in flight, stop, then its POST fails", () => {
    // the aborted stream is still outstanding, so the POST is the second
    // request; outcome 70 fails it without a 404
    const tally = reached([send, resolve, confirmEvent, { a: "answer", allow: true, stale: false },
      stop, { a: "server", pick: 1, outcome: 70 }]);
    expect(tally.get("confirm fails after stop")).toBe(1);
  });

  test("send, the models list with another default, then the create resolves", () => {
    const tally = reached([send, { a: "modelsLoaded", default: "haiku" }, resolve]);
    expect(tally.get("create resolves after a default landed meanwhile")).toBe(1);
  });

  test("a mutant that ignores Stop while creating is caught by `start`", () => {
    const step: StepFn = (s, e) => (e.type === "stop" && s.turn.phase === "creating"
      ? { state: s, effects: [] } : REAL.step(s, e));
    const { problems } = runActions([send, stop, resolve], { ...REAL, step });
    expect(problems.some((p) => p.startsWith("start: "))).toBe(true);
  });
});
