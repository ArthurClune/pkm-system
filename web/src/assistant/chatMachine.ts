// pattern: Functional Core
// The assistant panel's chat as one machine: the conversation it talks to,
// the one turn in flight, and what the panel shows. `step` takes an event
// and returns the next state plus the effects the hook (useAssistant.ts)
// runs; every request's result comes back as an event naming its turn.

import type { ConfirmId, ConversationId } from "../api/brands";
import type { AssistantModel } from "./client";
import type { AssistantEvent } from "./sse";
import type { WritePreview } from "./writePreview";

export type ChatItem =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  // `error` is a write's failure reason, `declined` a write the user denied
  // on its card, `warning` a batch's skipped-ops line; all come from the
  // server and are untrusted text/flags.
  | { kind: "tool"; toolUseId: string; name: string; summary: string;
      done: boolean; error: string | null; declined: boolean;
      warning?: string };

export type PendingConfirm = {
  confirmId: ConfirmId;
  opsPreview: string;
  preview: WritePreview | null;
  // the answer posted for this confirm, set only once it is posted. The
  // server may hold a failed answer already and ignores a changed one, so
  // after a failure only this answer may be sent again; it lives here rather
  // than in the card so a remounted card cannot forget it.
  sentDecision: boolean | null;
  // how many cards of this turn the user allowed before answering this one,
  // before it arrived or while it waited. When the server stamped the card
  // (`writes_in_flight`), one of those writes may have landed after it read
  // the current text, and the card says that text may have changed.
  allowedAhead: number;
};

/** What the busy line shows: the server's phase label ("reasoning",
 * "preparing save_note", "replying"), "stopping" after Stop, or null for the
 * unlabelled stretches (before the first stream event; while a tool runs),
 * plus when the current stretch started, so the panel can tick an elapsed
 * clock from it. */
export type PhaseInfo = { label: string | null; since: number };

/** Numbers the turns of one panel; a request's result names its turn, and
 * a result for any turn but the busy one changes nothing on screen. */
export type TurnId = number;

export type Conversation =
  | { kind: "none" }
  | { kind: "creating"; model: AssistantModel }
  | { kind: "open"; id: ConversationId; model: AssistantModel };

/** creating waits on the conversation. stopping is a Stop waiting for the
 * server to end the turn (`turn_stopped`, an `error`, or the stream's end)
 * or for the create to settle; its output is dropped. So the turn is idle
 * only once the server is, except when Stop's fallback aborts the stream
 * (useAssistant.ts `STOP_ACK_TIMEOUT_MS`) or New chat does. `recreated` is
 * set once the turn has re-created a conversation the server no longer
 * knew, so a second 404 fails instead of looping. */
export type Turn =
  | { phase: "idle" }
  | { phase: "creating"; id: TurnId; text: string; recreated: boolean }
  | { phase: "streaming"; id: TurnId; text: string; recreated: boolean }
  | { phase: "stopping"; id: TurnId };

export type ChatState = {
  conversation: Conversation;
  turn: Turn;
  /** the id the latest turn took; the next send takes the one after it */
  lastTurn: TurnId;
  items: ChatItem[];
  /** FIFO: a confirm arriving while one is on screen waits behind it, so the
   * card never changes under the user's cursor */
  confirms: PendingConfirm[];
  /** the head's answer is being posted; its buttons are disabled */
  answering: boolean;
  phase: PhaseInfo | null;
  error: string | null;
  /** the picker's choice while there is no conversation */
  picked: AssistantModel;
  /** the user chose `picked`, so the server's default must not replace it */
  pickTouched: boolean;
  models: AssistantModel[];
  /** The Allows posted since the last turn that finished, which a card
   * arriving now counts. A stopped turn's allowed write may still be
   * running, so its Allows carry over into the next turn. */
  allowedInTurn: number;
};

export type StreamFailure =
  | { kind: "aborted" }
  | { kind: "notFound"; message: string }
  | { kind: "failed"; message: string };

export type ChatEvent =
  | { type: "send"; text: string; at: number }
  | { type: "stop"; at: number }
  | { type: "newChat" }
  | { type: "pickModel"; model: AssistantModel }
  | { type: "modelsLoaded"; models: AssistantModel[] | null;
      default: AssistantModel | null }
  | { type: "created"; turn: TurnId; id: ConversationId; model: AssistantModel }
  | { type: "createFailed"; turn: TurnId; message: string }
  | { type: "streamEvent"; turn: TurnId; event: AssistantEvent; at: number }
  | { type: "streamEnded"; turn: TurnId }
  | { type: "streamFailed"; turn: TurnId; failure: StreamFailure }
  | { type: "answer"; confirmId: ConfirmId; allow: boolean }
  | { type: "confirmPosted"; turn: TurnId; conversation: ConversationId;
      confirmId: ConfirmId; allow: boolean; at: number }
  | { type: "confirmFailed"; turn: TurnId; confirmId: ConfirmId;
      notFound: boolean; message: string };

/** `delete.after` names a turn whose stream must settle first, so the server
 * has seen the dropped connection before the conversation is closed.
 * `postStop` asks the server to stop the turn; the hook aborts its stream if
 * the server does not end it in time. */
export type ChatEffect =
  | { kind: "create"; turn: TurnId; model: AssistantModel }
  | { kind: "stream"; turn: TurnId; conversation: ConversationId; text: string }
  | { kind: "abort"; turn: TurnId }
  | { kind: "postStop"; turn: TurnId; conversation: ConversationId }
  | { kind: "delete"; conversation: ConversationId; after: TurnId | null }
  | { kind: "confirm"; turn: TurnId; conversation: ConversationId;
      confirmId: ConfirmId; allow: boolean };

export type Step = { state: ChatState; effects: ChatEffect[] };
export type StepFn = (state: ChatState, event: ChatEvent) => Step;

/** The Claude models are always servable, so they double as the
 * offline/failed fallback; the server list adds glm only when a z.ai key is
 * configured. */
export const FALLBACK_MODELS: AssistantModel[] = ["sonnet", "opus", "haiku", "fable"];

export const EXPIRED_MESSAGE =
  "This chat expired before you responded; send a new message to start a fresh one.";

export function initialChat(): ChatState {
  return {
    conversation: { kind: "none" }, turn: { phase: "idle" }, lastTurn: 0,
    items: [], confirms: [], answering: false, phase: null, error: null,
    picked: "sonnet", pickTouched: false, models: FALLBACK_MODELS,
    allowedInTurn: 0,
  };
}

/** The model the picker shows: the conversation's once one is being
 * created or is open, else the user's choice. */
export function shownModel(s: ChatState): AssistantModel {
  return s.conversation.kind === "none" ? s.picked : s.conversation.model;
}

/** The picker is locked exactly while a conversation is being created or
 * is open: it shows that conversation's model, which cannot change. */
export function modelLocked(s: ChatState): boolean {
  return s.conversation.kind !== "none";
}

export function chatStatus(s: ChatState): "idle" | "busy" | "confirm" {
  if (s.confirms.length > 0) return "confirm";
  return s.turn.phase === "idle" ? "idle" : "busy";
}

/** The turn with this id is busy: its requests' results still count. */
export function turnBusy(s: ChatState, turn: TurnId): boolean {
  return s.turn.phase !== "idle" && s.turn.id === turn;
}

const IDLE: Turn = { phase: "idle" };
const NONE: Conversation = { kind: "none" };
const same = (state: ChatState): Step => ({ state, effects: [] });

/** An answer still in flight has nothing left to answer, and the next
 * turn's card must not wait on it. */
function endTurn(s: ChatState): ChatState {
  return { ...s, turn: IDLE, confirms: [], answering: false, phase: null };
}

/** The picker keeps showing the model the dropped conversation ran. */
function dropConversation(s: ChatState): ChatState {
  return { ...s, conversation: NONE, picked: shownModel(s) };
}

function applyStreamEvent(s: ChatState, ev: AssistantEvent, at: number): ChatState {
  switch (ev.type) {
    case "text_delta": {
      const last = s.items[s.items.length - 1];
      if (last && last.kind === "assistant") {
        return { ...s, items: [...s.items.slice(0, -1),
          { kind: "assistant", text: last.text + ev.text }] };
      }
      return { ...s, items: [...s.items, { kind: "assistant", text: ev.text }] };
    }
    case "tool_started":
      return {
        ...s,
        items: [...s.items, {
          kind: "tool", toolUseId: ev.tool_use_id, name: ev.name,
          summary: ev.summary, done: false, error: null, declined: false,
        }],
        // the tool's own line takes over from a stale "preparing …" label
        phase: { label: null, since: at },
      };
    case "phase":
      return { ...s, phase: { label: ev.label, since: at } };
    case "tool_finished": {
      const idx = s.items.findIndex(
        (item) => item.kind === "tool" && item.toolUseId === ev.tool_use_id && !item.done);
      const item = s.items[idx];
      if (item === undefined || item.kind !== "tool") return s;
      return { ...s, items: [...s.items.slice(0, idx), {
        ...item, done: true, error: ev.error ?? null,
        declined: ev.declined === true, warning: ev.warning ?? undefined,
      }, ...s.items.slice(idx + 1)] };
    }
    case "confirm_request":
      return { ...s, confirms: [...s.confirms, {
        confirmId: ev.confirm_id, opsPreview: ev.ops_preview, preview: ev.preview,
        sentDecision: null, allowedAhead: s.allowedInTurn,
      }] };
    case "turn_done":
      return { ...s, allowedInTurn: 0 };
    case "error":
      return { ...s, error: ev.message };
    case "turn_stopped":
      return s;
  }
}

export function step(s: ChatState, e: ChatEvent): Step {
  const t = s.turn;
  switch (e.type) {
    case "send": {
      // at most one turn is busy; the panel also disables Send meanwhile
      if (!e.text.trim() || t.phase !== "idle" || s.conversation.kind === "creating") {
        return same(s);
      }
      const id = s.lastTurn + 1;
      const base: ChatState = {
        ...s, lastTurn: id, error: null, phase: { label: null, since: e.at },
        items: [...s.items, { kind: "user", text: e.text }],
      };
      if (s.conversation.kind === "open") {
        return {
          state: { ...base, turn: { phase: "streaming", id, text: e.text, recreated: false } },
          effects: [{ kind: "stream", turn: id, conversation: s.conversation.id, text: e.text }],
        };
      }
      return {
        state: { ...base, conversation: { kind: "creating", model: s.picked },
                 turn: { phase: "creating", id, text: e.text, recreated: false } },
        effects: [{ kind: "create", turn: id, model: s.picked }],
      };
    }
    case "stop": {
      const stopping: ChatState = { ...s, phase: { label: "stopping", since: e.at } };
      // a create cannot be called back, so its result is awaited and kept,
      // but no stream starts from it
      if (t.phase === "creating") return same({ ...stopping, turn: { phase: "stopping", id: t.id } });
      if (t.phase === "streaming" && s.conversation.kind === "open") {
        return {
          state: { ...stopping, turn: { phase: "stopping", id: t.id }, confirms: [], answering: false },
          effects: [{ kind: "postStop", turn: t.id, conversation: s.conversation.id }],
        };
      }
      return same(s);
    }
    case "newChat": {
      const effects: ChatEffect[] = [];
      // a stopping turn's stream may still be open; aborting one with no
      // stream does nothing
      if (t.phase === "streaming" || t.phase === "stopping") {
        effects.push({ kind: "abort", turn: t.id });
      }
      if (s.conversation.kind === "open") {
        effects.push({ kind: "delete", conversation: s.conversation.id,
                       after: t.phase === "idle" ? null : t.id });
      }
      return {
        state: { ...endTurn(dropConversation(s)), items: [], error: null },
        effects,
      };
    }
    case "pickModel":
      if (s.conversation.kind !== "none") return same(s);
      return same({ ...s, picked: e.model, pickTouched: true });
    case "modelsLoaded": {
      let next = s;
      if (e.models !== null && e.models.length > 0) next = { ...next, models: e.models };
      if (e.default !== null && !s.pickTouched && s.conversation.kind === "none") {
        next = { ...next, picked: e.default };
      }
      return same(next);
    }
    case "created": {
      if (!turnBusy(s, e.turn) || t.phase === "idle" || s.conversation.kind !== "creating") {
        // superseded by New chat: adopting it would make the new chat
        // continue the old one, so close it rather than leak it until the
        // server reaps it
        return { state: s, effects: [{ kind: "delete", conversation: e.id, after: null }] };
      }
      // a new conversation runs none of the old one's writes
      const opened: ChatState = {
        ...s, conversation: { kind: "open", id: e.id, model: e.model }, allowedInTurn: 0,
      };
      if (t.phase !== "creating") return same(endTurn(opened));
      return {
        state: { ...opened, turn: { ...t, phase: "streaming" } },
        effects: [{ kind: "stream", turn: t.id, conversation: e.id, text: t.text }],
      };
    }
    case "createFailed": {
      if (!turnBusy(s, e.turn) || s.conversation.kind !== "creating") return same(s);
      const dropped = endTurn(dropConversation(s));
      return same(t.phase === "creating" ? { ...dropped, error: e.message } : dropped);
    }
    case "streamEvent":
      if (!turnBusy(s, e.turn) || t.phase === "creating") return same(s);
      // the server's last word on the turn: it can take the next one
      if (e.event.type === "turn_stopped"
          || (t.phase === "stopping" && e.event.type === "error")) {
        return same(endTurn(s));
      }
      if (t.phase !== "streaming") return same(s);
      return same(applyStreamEvent(s, e.event, e.at));
    case "streamEnded":
      if (!turnBusy(s, e.turn) || t.phase === "creating") return same(s);
      return same(endTurn(s));
    case "streamFailed": {
      if (!turnBusy(s, e.turn) || t.phase === "creating") return same(s);
      const f = e.failure;
      // the server reaped the conversation (idle timeout, eviction, a lost
      // harness): re-create it once with the same model and resend
      if (t.phase === "streaming" && f.kind === "notFound" && !t.recreated
          && s.conversation.kind === "open") {
        const model = s.conversation.model;
        return {
          state: { ...s, conversation: { kind: "creating", model },
                   turn: { ...t, phase: "creating", recreated: true },
                   confirms: [], answering: false },
          effects: [{ kind: "create", turn: t.id, model }],
        };
      }
      let next = endTurn(s);
      if (f.kind === "notFound") next = dropConversation(next);
      // after Stop every failure, the abort itself included, is the Stop
      if (t.phase === "streaming" && f.kind !== "aborted") next = { ...next, error: f.message };
      return same(next);
    }
    case "answer": {
      const head = s.confirms[0];
      if (head === undefined || s.answering || head.confirmId !== e.confirmId
          || t.phase !== "streaming" || s.conversation.kind !== "open") return same(s);
      if (head.sentDecision !== null && head.sentDecision !== e.allow) return same(s);
      return {
        state: { ...s, answering: true,
                 confirms: [{ ...head, sentDecision: e.allow }, ...s.confirms.slice(1)] },
        effects: [{ kind: "confirm", turn: t.id, conversation: s.conversation.id,
                    confirmId: head.confirmId, allow: e.allow }],
      };
    }
    case "confirmPosted": {
      let next = s;
      if (e.allow && s.conversation.kind === "open" && s.conversation.id === e.conversation) {
        next = { ...next, allowedInTurn: next.allowedInTurn + 1 };
      }
      const head = next.confirms[0];
      if (t.phase !== "streaming" || t.id !== e.turn || head === undefined
          || head.confirmId !== e.confirmId) return same(next);
      const rest = next.confirms.slice(1)
        .map((p) => (e.allow ? { ...p, allowedAhead: p.allowedAhead + 1 } : p));
      // the parked stretch was the user's silence, not the model's: restart
      // the busy line's clock rather than resume a stale label
      return same({ ...next, answering: false, confirms: rest,
                    phase: rest.length === 0 ? { label: null, since: e.at } : next.phase });
    }
    case "confirmFailed": {
      // after Stop, a turn's end or New chat there is no card left to answer
      // again, so the failure is not news
      if (t.phase !== "streaming" || t.id !== e.turn) return same(s);
      if (e.notFound) {
        // reaped while waiting on the user's decision: no live turn to
        // resume, so start clean rather than resurrect a dead card or the
        // ones queued behind it
        return {
          state: { ...endTurn(dropConversation(s)), error: EXPIRED_MESSAGE },
          effects: [{ kind: "abort", turn: t.id }],
        };
      }
      // the same card stays, so the user can answer it again
      return same({ ...s, answering: false, error: e.message });
    }
  }
}
