// pattern: Functional Core
// The assistant property's alphabet: the user's actions and every way a
// request the panel made can settle, freely interleaved. A request's result
// is its own action, so Stop, New chat, a model pick or the models list can
// land between a request and its result, inside conversation creation and
// inside a turn.
//
// `server` settles one outstanding request (`pick` among them) with an
// outcome its kind allows (run.ts `outcomeFor`):
//   create   resolves, or fails
//   stream   an event (text, tool started or finished, phase, a confirm
//            request, turn_done, an in-band error), ends, fails, a 404 before
//            its first event (the server reaped the conversation), or the
//            harness is lost (HARNESS_LOST, the conversation retired, and the
//            stream ends later); an aborted stream mostly rejects with an
//            AbortError, but may still deliver an event or end first
//   confirm  posts, fails, or 404s (the conversation is gone)
// `reap` retires a conversation with no turn running, as idle reaping and
// oldest-idle eviction do.
import fc from "fast-check";
import type { AssistantModel } from "../../assistant/client";

export type Action =
  | { a: "send"; blank: boolean }
  | { a: "stop" }
  | { a: "newChat" }
  | { a: "pick"; model: AssistantModel }
  | { a: "modelsLoaded"; default: AssistantModel }
  | { a: "answer"; allow: boolean; stale: boolean }
  | { a: "server"; pick: number; outcome: number }
  | { a: "reap"; pick: number };

/** `outcome` is a percentile; run.ts maps it to a weighted outcome. */
export const OUTCOME_MAX = 99;

const MODELS: AssistantModel[] = ["sonnet", "opus", "haiku", "fable", "glm"];
const pick = fc.nat({ max: 3 });
const model = fc.constantFrom(...MODELS);
const rarely = fc.constantFrom(false, false, false, true);

export const actionArb: fc.Arbitrary<Action> = fc.oneof(
  { weight: 5, arbitrary: fc.record({ a: fc.constant("send" as const), blank: rarely }) },
  { weight: 3, arbitrary: fc.constant({ a: "stop" as const }) },
  { weight: 1, arbitrary: fc.constant({ a: "newChat" as const }) },
  { weight: 1, arbitrary: fc.record({ a: fc.constant("pick" as const), model }) },
  { weight: 1, arbitrary: fc.record({ a: fc.constant("modelsLoaded" as const), default: model }) },
  { weight: 4, arbitrary: fc.record({ a: fc.constant("answer" as const), allow: fc.boolean(),
                                      stale: rarely }) },
  { weight: 12, arbitrary: fc.record({ a: fc.constant("server" as const), pick,
                                       outcome: fc.nat({ max: OUTCOME_MAX }) }) },
  { weight: 1, arbitrary: fc.record({ a: fc.constant("reap" as const), pick }) },
);

// "max": fast-check's default size keeps arrays near ten long, too short for a
// turn that re-creates its conversation and is then stopped
export const actionsArb = fc.array(actionArb, { minLength: 1, maxLength: 40, size: "max" });
