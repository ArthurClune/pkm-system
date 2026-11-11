import { describe, expect, test } from "vitest";
import { answerFailed, type StepFn } from "../../assistant/chatMachine";
import type { Action } from "./arbitraries";
import { REAL, runActions, type Tally } from "./run";

const send: Action = { a: "send", blank: false };
const stop: Action = { a: "stop" };
// outcome 0 resolves a create, and is a stream's first event kind (text)
const resolve: Action = { a: "server", pick: 0, outcome: 0 };
const notFound: Action = { a: "server", pick: 0, outcome: 80 };
const confirmEvent: Action = { a: "server", pick: 0, outcome: 4 };
const allow: Action = { a: "answer", allow: true, stale: false };
const deny: Action = { a: "answer", allow: false, stale: false };
// the stream is the first request and the confirm POST the second; outcome
// 70 fails the POST without a 404
const confirmFails: Action = { a: "server", pick: 1, outcome: 70 };
const allowFails = [send, resolve, confirmEvent, allow, confirmFails];

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

  test("send, stop while streaming, then the server says the turn stopped", () => {
    // outcome 0 on a stopped stream is turn_stopped
    const tally = reached([send, resolve, stop, resolve, send]);
    expect(tally.get("stop while streaming")).toBe(1);
    expect(tally.get("turn_stopped after stop")).toBe(1);
  });

  test("send, stop while streaming, then the stop's fallback aborts the stream", () => {
    const tally = reached([send, resolve, stop, { a: "server", pick: 0, outcome: 55 }]);
    expect(tally.get("stop's fallback aborts after stop")).toBe(1);
  });

  test("send, then a turn_stopped the turn did not ask for", () => {
    // outcome 53 on an unstopped stream is a stop meant for an earlier turn
    const tally = reached([send, resolve, { a: "server", pick: 0, outcome: 53 }]);
    expect(tally.get("unasked turn_stopped")).toBe(1);
  });

  test("send, stop, the stream ends, then the stop POST settles late", () => {
    // the stream is the first request and the stop POST the second
    const tally = reached([send, resolve, stop, { a: "server", pick: 0, outcome: 65 },
                           { a: "server", pick: 0, outcome: 0 }, send]);
    expect(tally.get("stop POST settles late after stop")).toBe(1);
  });

  test("a mutant that aborts on Stop instead of posting one is caught by `stop`", () => {
    const step: StepFn = (s, e) => {
      if (e.type !== "stop" || s.turn.phase !== "streaming") return REAL.step(s, e);
      const out = REAL.step(s, e);
      return { state: out.state, effects: [{ kind: "abort", turn: s.turn.id }] };
    };
    const { problems } = runActions([send, resolve, stop], { ...REAL, step });
    expect(problems.some((p) => p.startsWith("stop: "))).toBe(true);
  });

  test("send, the models list with another default, then the create resolves", () => {
    const tally = reached([send, { a: "modelsLoaded", default: "haiku" }, resolve]);
    expect(tally.get("create resolves after a default landed meanwhile")).toBe(1);
  });

  test("an Allow fails, then a Deny posts nothing and the Allow goes again", () => {
    const actions = [...allowFails, deny, allow, allow];
    const tally = reached(actions);
    expect(tally.get("answer changed after a failure")).toBe(1);
    expect(tally.get("answer repeated after a failure")).toBe(1);
    expect(tally.get("answer while posting")).toBe(1);
    const answers = runActions(actions).trace.filter((t) => t.startsWith('{"type":"answer"'))
      .map((t) => t.slice(t.indexOf(" -> ") + 4));
    expect(answers.map((effects) => effects !== "[]")).toEqual([true, false, true, false]);
  });

  test("a mutant that lets a failed answer change is caught by `confirm`", () => {
    const step: StepFn = (s, e) => {
      const head = s.confirms[0];
      if (e.type !== "answer" || head === undefined || !answerFailed(head)
          || head.answer.allow === e.allow) return REAL.step(s, e);
      return REAL.step({ ...s, confirms: [{ ...head, answer: null }, ...s.confirms.slice(1)] }, e);
    };
    const { problems } = runActions([...allowFails, deny], { ...REAL, step });
    expect(problems.some((p) => p.startsWith("confirm: "))).toBe(true);
  });

  test("a mutant that drops every answer is caught by `confirm`", () => {
    const step: StepFn = (s, e) => (e.type === "answer" ? { state: s, effects: [] } : REAL.step(s, e));
    const { problems } = runActions([send, resolve, confirmEvent, allow], { ...REAL, step });
    expect(problems.some((p) => p.startsWith("confirm: "))).toBe(true);
  });

  test("a mutant whose Retry after a failure posts nothing is caught by `confirm`", () => {
    const step: StepFn = (s, e) => {
      const head = s.confirms[0];
      return e.type === "answer" && head !== undefined && answerFailed(head)
        && head.answer.allow === e.allow ? { state: s, effects: [] } : REAL.step(s, e);
    };
    const { problems } = runActions([...allowFails, allow], { ...REAL, step });
    expect(problems.some((p) => p.startsWith("confirm: "))).toBe(true);
  });

  test("a mutant that leaves a failed card posting is caught by `confirm`", () => {
    const step: StepFn = (s, e) => (e.type === "confirmFailed" && !e.notFound
      ? { state: { ...s, error: e.message }, effects: [] } : REAL.step(s, e));
    const { problems } = runActions(allowFails, { ...REAL, step });
    expect(problems.some((p) => p.startsWith("confirm: "))).toBe(true);
  });

  test("a view that hides Stop once an answer failed is caught by `stoppable`", () => {
    const view: typeof REAL.view = (s) => {
      const head = s.confirms[0];
      return head !== undefined && answerFailed(head)
        ? { ...REAL.view(s), stoppable: false } : REAL.view(s);
    };
    const { problems } = runActions(allowFails, { ...REAL, view });
    expect(problems.some((p) => p.startsWith("stoppable: "))).toBe(true);
  });

  test("a mutant that ignores Stop while creating is caught by `start`", () => {
    const step: StepFn = (s, e) => (e.type === "stop" && s.turn.phase === "creating"
      ? { state: s, effects: [] } : REAL.step(s, e));
    const { problems } = runActions([send, stop, resolve], { ...REAL, step });
    expect(problems.some((p) => p.startsWith("start: "))).toBe(true);
  });
});
