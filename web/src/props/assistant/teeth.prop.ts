// pattern: Imperative Shell
// The assistant property's teeth: deliberately wrong versions of the chat
// machine, swapped in through the runner's seam, each of which the property
// must catch. A mutant that survives means the property cannot see that bug.
// A catch counts only when the problems include the invariant the mutant
// breaks; a crash, or another invariant failing alone, is not the property
// seeing the bug.
//
// The first three put back the bugs the machine fixed: Stop doing nothing
// while the conversation is being created, a confirm failure after Stop
// showing an error, and the picker following the server's default (or
// staying locked) when no conversation runs that model.
import fc from "fast-check";
import { expect, test } from "vitest";
import {
  turnBusy, type ChatEvent, type ChatState, type Step,
} from "../../assistant/chatMachine";
import { SEED } from "../env";
import { captureFaultWarnings } from "../warningsCapture";
import { actionsArb } from "./arbitraries";
import { REAL, runActions, type Machine } from "./run";

captureFaultWarnings("assistant teeth");

const NUM_RUNS = 20_000;
const TIME_LIMIT_MS = 15_000;
const CLEAN_RUNS = 20_000;

class PropertyReport extends Error {}

/** The real step, except where `wrong` answers first. */
function mutate(wrong: (s: ChatState, e: ChatEvent) => Step | null): Machine {
  return { ...REAL, step: (s, e) => wrong(s, e) ?? REAL.step(s, e) };
}

const MUTANTS: Record<string, { catches: string[]; machine: Machine }> = {
  // A stopped create that streams starts a request (start); one that fails
  // shows its error (silent). Which comes first depends on the seed.
  "Stop does nothing while the conversation is being created": {
    catches: ["start", "silent"],
    machine: mutate((s, e) =>
      (e.type === "stop" && s.turn.phase === "creating" ? { state: s, effects: [] } : null)),
  },
  "a confirm POST that fails after Stop shows its error": {
    catches: ["silent"],
    machine: mutate((s, e) => (e.type === "confirmFailed" && s.turn.phase !== "streaming"
      ? { state: { ...s, error: e.message }, effects: [] } : null)),
  },
  "the server's default lands while the conversation is being created": {
    catches: ["picker"],
    machine: {
      step: (s, e) => (e.type === "modelsLoaded" && e.default !== null && !s.pickTouched
        && s.conversation.kind === "creating"
        ? { state: { ...s, picked: e.default }, effects: [] } : REAL.step(s, e)),
      view: (s) => ({ ...REAL.view(s),
                      model: s.conversation.kind === "open" ? s.conversation.model : s.picked }),
    },
  },
  "the picker stays locked once a message was sent": {
    catches: ["picker"],
    machine: { ...REAL, view: (s) => ({ ...REAL.view(s),
      locked: s.conversation.kind !== "none" || s.items.some((i) => i.kind === "user") }) },
  },
  // Two turns in flight (one), or the first's results ignored so the panel
  // goes idle while that turn still streams (status).
  "a send while streaming starts a second turn": {
    catches: ["one", "status"],
    machine: mutate((s, e) => (e.type === "send" && s.turn.phase === "streaming"
      ? REAL.step({ ...s, turn: { phase: "idle" } }, e) : null)),
  },
  "a stopped turn's stream events still show": {
    catches: ["silent"],
    machine: mutate((s, e) => {
      if (e.type !== "streamEvent" || s.turn.phase !== "stopping" || s.turn.id !== e.turn
          || e.event.type === "turn_stopped") return null;
      const as = REAL.step({ ...s, turn: { phase: "streaming", id: e.turn, text: "", recreated: true } }, e);
      return { state: { ...as.state, turn: s.turn }, effects: as.effects };
    }),
  },
  // The acknowledged Stop: the panel must ask the server, and stay busy
  // until the server has ended the turn.
  "Stop on a streaming turn aborts the stream instead of posting a stop": {
    catches: ["stop"],
    machine: mutate((s, e) => {
      if (e.type !== "stop" || s.turn.phase !== "streaming") return null;
      return { state: REAL.step(s, e).state, effects: [{ kind: "abort", turn: s.turn.id }] };
    }),
  },
  "Stop frees the panel before the server has ended the turn": {
    catches: ["status"],
    machine: mutate((s, e) => {
      if (e.type !== "stop" || s.turn.phase !== "streaming") return null;
      const out = REAL.step(s, e);
      return { state: { ...out.state, turn: { phase: "idle" } }, effects: out.effects };
    }),
  },
  "a stopping turn ignores turn_stopped": {
    catches: ["status"],
    machine: mutate((s, e) => (e.type === "streamEvent" && e.event.type === "turn_stopped"
      && s.turn.phase === "stopping" ? { state: s, effects: [] } : null)),
  },
  "a conversation created for a superseded turn is left open": {
    catches: ["leak"],
    machine: mutate((s, e) => (e.type === "created" && !turnBusy(s, e.turn)
      ? { state: s, effects: [] } : null)),
  },
};

for (const [name, { machine, catches }] of Object.entries(MUTANTS)) {
  test(`the assistant property catches: ${name}`, async () => {
    const details = await fc.check(fc.asyncProperty(actionsArb, async (actions) => {
      const { problems } = runActions(actions, machine);
      if (problems.length > 0) throw new PropertyReport(problems.join("\n"));
    }), {
      numRuns: NUM_RUNS, seed: SEED, endOnFailure: true,
      interruptAfterTimeLimit: TIME_LIMIT_MS,
    });
    const cutOff = details.interrupted
      ? ` (cut off by the ${TIME_LIMIT_MS / 1000}s time limit, not a full run)` : "";
    expect(details.failed, `mutant survived ${details.numRuns} runs${cutOff}` +
      ` (seed ${details.seed}): ${name}`).toBe(true);
    const error = details.errorInstance;
    expect(error instanceof PropertyReport, `mutant caught by a thrown error, not a property` +
      ` report (seed ${details.seed}): ${name}: ${String(error)}`).toBe(true);
    const lines = (error as PropertyReport).message.split("\n");
    expect(lines.some((line) => catches.some((p) => line.startsWith(`${p}: `))),
           `mutant caught, but not by ${catches.join(" or ")} (seed ${details.seed}):` +
           ` ${name}:\n${lines.join("\n")}`).toBe(true);
  });
}

test("the real machine passes the same runs", async () => {
  const details = await fc.check(fc.asyncProperty(actionsArb, async (actions) => {
    const { problems } = runActions(actions, REAL);
    if (problems.length > 0) throw new PropertyReport(problems.join("\n"));
  }), { numRuns: CLEAN_RUNS, seed: SEED });
  expect(details.failed, `clean run failed (seed ${details.seed}):` +
    ` ${String(details.errorInstance)}`).toBe(false);
});
