// pattern: Functional Core
// What the assistant panel must do, stated from frontend.md § The chat
// machine and assistant.md § The turn phase: which conversation the
// panel talks to, which turn is busy, what the picker shows, and which
// requests each step must and must not start. It never calls the reducer it
// checks; where the two disagree, the disagreement is a finding.
import type { AssistantModel } from "../../assistant/client";

export type Conv =
  | { kind: "none" }
  | { kind: "creating"; model: AssistantModel }
  | { kind: "open"; id: string; model: AssistantModel };

/** `turn` is the id the reducer gave the turn, read off its first request. */
export type Busy = { turn: number; stage: "creating" | "streaming"; stopped: boolean;
                     recreated: boolean };

export type Doc = {
  conv: Conv;
  busy: Busy | null;
  picked: AssistantModel;
  touched: boolean;
};

export const START: Doc = {
  conv: { kind: "none" }, busy: null, picked: "sonnet", touched: false,
};

/** One step, as the model sees it. Request results name the turn the
 * request was made for. */
export type Input =
  | { k: "send"; blank: boolean }
  | { k: "stop" }
  | { k: "newChat" }
  | { k: "pick"; model: AssistantModel }
  | { k: "modelsLoaded"; default: AssistantModel }
  | { k: "answer" }
  | { k: "created"; turn: number; id: string; model: AssistantModel }
  | { k: "createFailed"; turn: number }
  | { k: "streamEvent"; turn: number }
  | { k: "streamEnded"; turn: number }
  | { k: "streamFailed"; turn: number; failure: "notFound" | "failed" | "aborted" }
  | { k: "confirmPosted"; turn: number }
  | { k: "confirmFailed"; turn: number; notFound: boolean };

/** What the step must do. `start` is the one request a step may start (a
 * create with this model, or a stream to this conversation); a step with no
 * `start` starts none. `turn` is the turn it must be for, or "new" for a
 * turn id never seen. `silent`: the transcript, the cards and the error line
 * must not change. `error`: "set" means a failure the user must see. */
export type Expectation = {
  start: null
    | { kind: "create"; model: AssistantModel; turn: number | "new" }
    | { kind: "stream"; conversation: string; turn: number | "new" };
  deletes: string[];
  aborts: number[];
  mayConfirm: boolean;
  silent: boolean;
  error: "set" | "cleared" | "any";
};

const NOTHING: Expectation = {
  start: null, deletes: [], aborts: [], mayConfirm: false, silent: true, error: "any",
};

/** The picker shows the model of the conversation being created or open,
 * else the user's choice. */
export function shown(doc: Doc): AssistantModel {
  return doc.conv.kind === "none" ? doc.picked : doc.conv.model;
}

const dropConv = (doc: Doc): Doc => ({ ...doc, conv: { kind: "none" }, picked: shown(doc) });

/** The results of the busy turn's own requests still count, unless it was
 * stopped: after Stop no output of that turn reaches the panel. */
function live(doc: Doc, turn: number): Busy | null {
  return doc.busy !== null && doc.busy.turn === turn ? doc.busy : null;
}

export function expect(doc: Doc, input: Input): { doc: Doc; expect: Expectation } {
  const b = doc.busy;
  switch (input.k) {
    case "send": {
      if (input.blank || b !== null) return { doc, expect: NOTHING };
      const busy: Busy = { turn: -1, stage: "creating", stopped: false, recreated: false };
      const ex = { ...NOTHING, silent: false, error: "cleared" as const };
      if (doc.conv.kind === "open") {
        return { doc: { ...doc, busy: { ...busy, stage: "streaming" } },
                 expect: { ...ex, start: { kind: "stream", conversation: doc.conv.id, turn: "new" } } };
      }
      return { doc: { ...doc, busy, conv: { kind: "creating", model: doc.picked } },
               expect: { ...ex, start: { kind: "create", model: doc.picked, turn: "new" } } };
    }
    case "stop": {
      if (b === null || b.stopped) return { doc, expect: NOTHING };
      // Stop clears any card: the server declines a parked confirm
      return { doc: { ...doc, busy: { ...b, stopped: true } },
               expect: { ...NOTHING, silent: false,
                         aborts: b.stage === "streaming" ? [b.turn] : [] } };
    }
    case "newChat": {
      const aborts = b !== null && b.stage === "streaming" && !b.stopped ? [b.turn] : [];
      const deletes = doc.conv.kind === "open" ? [doc.conv.id] : [];
      return { doc: { ...dropConv(doc), busy: null },
               expect: { ...NOTHING, silent: false, aborts, deletes } };
    }
    case "pick":
      if (doc.conv.kind !== "none") return { doc, expect: NOTHING };
      return { doc: { ...doc, picked: input.model, touched: true }, expect: NOTHING };
    case "modelsLoaded":
      if (doc.conv.kind !== "none" || doc.touched) return { doc, expect: NOTHING };
      return { doc: { ...doc, picked: input.default }, expect: NOTHING };
    case "answer":
      return { doc, expect: { ...NOTHING, silent: false,
                              mayConfirm: b !== null && !b.stopped && b.stage === "streaming" } };
    case "created": {
      const t = live(doc, input.turn);
      if (t === null || t.stage !== "creating") {
        // a conversation nobody will use is closed, not leaked
        return { doc, expect: { ...NOTHING, deletes: [input.id] } };
      }
      const opened: Doc = { ...doc, conv: { kind: "open", id: input.id, model: input.model } };
      if (t.stopped) return { doc: { ...opened, busy: null }, expect: NOTHING };
      return { doc: { ...opened, busy: { ...t, stage: "streaming" } },
               expect: { ...NOTHING, silent: false,
                         start: { kind: "stream", conversation: input.id, turn: t.turn } } };
    }
    case "createFailed": {
      const t = live(doc, input.turn);
      if (t === null || t.stage !== "creating") return { doc, expect: NOTHING };
      return { doc: { ...dropConv(doc), busy: null },
               expect: t.stopped ? NOTHING : { ...NOTHING, silent: false, error: "set" } };
    }
    case "streamEvent": {
      const t = live(doc, input.turn);
      if (t === null || t.stopped || t.stage !== "streaming") return { doc, expect: NOTHING };
      return { doc, expect: { ...NOTHING, silent: false } };
    }
    case "streamEnded": {
      const t = live(doc, input.turn);
      if (t === null || t.stage !== "streaming") return { doc, expect: NOTHING };
      return { doc: { ...doc, busy: null }, expect: t.stopped ? NOTHING : { ...NOTHING, silent: false } };
    }
    case "streamFailed": {
      const t = live(doc, input.turn);
      if (t === null || t.stage !== "streaming") return { doc, expect: NOTHING };
      if (input.failure === "notFound" && !t.stopped && !t.recreated
          && doc.conv.kind === "open") {
        // the server retired the conversation (reaped, evicted, or its
        // harness lost): re-create it once, with the same model
        const model = doc.conv.model;
        return { doc: { ...doc, conv: { kind: "creating", model },
                        busy: { ...t, stage: "creating", recreated: true } },
                 expect: { ...NOTHING, silent: false,
                           start: { kind: "create", model, turn: t.turn } } };
      }
      const ended: Doc = input.failure === "notFound" ? dropConv(doc) : doc;
      return { doc: { ...ended, busy: null },
               expect: t.stopped ? NOTHING
                 : { ...NOTHING, silent: false, error: input.failure === "aborted" ? "any" : "set" } };
    }
    case "confirmPosted": {
      const t = live(doc, input.turn);
      if (t === null || t.stopped) return { doc, expect: NOTHING };
      return { doc, expect: { ...NOTHING, silent: false } };
    }
    case "confirmFailed": {
      const t = live(doc, input.turn);
      if (t === null || t.stopped || t.stage !== "streaming") return { doc, expect: NOTHING };
      if (input.notFound) {
        return { doc: { ...dropConv(doc), busy: null },
                 expect: { ...NOTHING, silent: false, error: "set", aborts: [t.turn] } };
      }
      return { doc, expect: { ...NOTHING, silent: false, error: "set" } };
    }
  }
}
