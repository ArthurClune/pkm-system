// pattern: Functional Core
// The chat driver property's alphabet: the user's actions, every way a
// request the driver sent can settle, and the clock, freely interleaved. A
// request's opening, each of its stream's events, its settling and the
// abort that may come before it are separate actions, so Stop, New chat and
// the timers land between any two of them.
//
// `settle` acts on one outstanding fake request (`pick` among them) with an
// outcome its state allows (driverRun.ts `settleStream` and siblings):
//   create   resolves, or fails
//   stream   before its response: opens, 404s, 409s (the server still holds
//            the last turn) or fails; once open: an event (text, a tool, a
//            confirm request, turn_done, an in-band error, turn_stopped),
//            ends, or fails; once aborted it mostly rejects with an
//            AbortError, but an opened one may still deliver an event or end
//   stop     resolves or fails; once aborted, rejects with an AbortError or
//            resolves (the answer was already on its way)
//   delete   resolves or fails
//   confirm  posts, fails, or 404s
// `tick` fires the driver's next timer, or moves the clock on by the stop
// fallback's whole bound.
import fc from "fast-check";

export type DriverAction =
  | { a: "send"; blank: boolean }
  | { a: "stop" }
  | { a: "newChat" }
  | { a: "answer"; allow: boolean }
  | { a: "settle"; pick: number; outcome: number }
  | { a: "tick"; to: "next" | "bound" };

/** `outcome` is a percentile; driverRun.ts maps it to a weighted outcome. */
export const OUTCOME_MAX = 99;

const rarely = fc.constantFrom(false, false, false, true);

export const driverActionArb: fc.Arbitrary<DriverAction> = fc.oneof(
  { weight: 4, arbitrary: fc.record({ a: fc.constant("send" as const), blank: rarely }) },
  { weight: 3, arbitrary: fc.constant({ a: "stop" as const }) },
  { weight: 2, arbitrary: fc.constant({ a: "newChat" as const }) },
  { weight: 3, arbitrary: fc.record({ a: fc.constant("answer" as const), allow: fc.boolean() }) },
  { weight: 14, arbitrary: fc.record({ a: fc.constant("settle" as const), pick: fc.nat({ max: 3 }),
                                       outcome: fc.nat({ max: OUTCOME_MAX }) }) },
  { weight: 3, arbitrary: fc.record({ a: fc.constant("tick" as const),
                                      to: fc.constantFrom("next" as const, "next" as const,
                                                          "bound" as const) }) },
);

export const driverActionsArb = fc.array(driverActionArb, { minLength: 1, maxLength: 40,
                                                            size: "max" });
