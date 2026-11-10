// pattern: Functional Core
// Runs one drawn action list against the chat reducer, with a simulated
// server and network standing in for the hook's requests: each request the
// reducer starts waits here until an action settles it, so user actions and
// server events land between a request and its result. Every step is
// checked against the docs model (model.ts) and the invariants below; each
// problem names its invariant first so a failing run says which one broke.
//
//   start   a step starts exactly the request the model expects, or none
//   stop    Stop on a streaming turn posts a stop for it, to its
//           conversation, and nothing else does
//   one     at most one turn has a live request (create, or a stream that
//           is neither aborted nor past its last event), and a live stream
//           is the busy turn's, stopped or not
//   silent  a stopped, superseded or finished turn's results change nothing
//           on screen: no item, no card, no error
//   picker  the picker shows the model of the conversation being created or
//           open, and is locked exactly then
//   status  the panel is busy exactly while the model has a busy turn
//   error   a failure of the busy turn shows; a send clears the line
//   leak    every conversation the server made is open, deleted or retired
//   confirm an answer posts at most once at a time, for the head card of the
//           busy, unstopped turn's open conversation
import type { ConfirmId, ConversationId } from "../../api/brands";
import {
  chatStatus, initialChat, modelLocked, shownModel, step as realStep,
  type ChatEffect, type ChatEvent, type ChatState, type StepFn,
} from "../../assistant/chatMachine";
import type { AssistantModel } from "../../assistant/client";
import type { AssistantEvent } from "../../assistant/sse";
import { confirmIdOf, conversationIdOf } from "../../test-helpers";
import type { Action } from "./arbitraries";
import { START, expect as modelExpect, shown, type Doc, type Expectation, type Input } from "./model";

export type View = {
  model: AssistantModel;
  locked: boolean;
  status: "idle" | "busy" | "confirm";
  items: readonly unknown[];
  confirms: readonly { confirmId: ConfirmId }[];
  error: string | null;
};

/** The seam teeth.prop.ts swaps mutants through. */
export type Machine = { step: StepFn; view: (s: ChatState) => View };

export const REAL: Machine = {
  step: realStep,
  view: (s) => ({
    model: shownModel(s), locked: modelLocked(s), status: chatStatus(s),
    items: s.items, confirms: s.confirms, error: s.error,
  }),
};

const KINDS = ["text", "toolStarted", "toolFinished", "phase", "confirm", "confirm",
               "confirm", "turnDone", "error"] as const;
type StreamKind = typeof KINDS[number];

export const HARNESS_LOST = "The assistant stopped responding. Start a new chat.";

/** `key` names one request across the copies its updates make. */
type Req = { key: number } & (
  | { kind: "create"; turn: number; model: AssistantModel }
  // `started`: an event arrived, so the POST was answered; `lost`: the
  // server forgot the conversation, so the stream can only end; `stopPosted`:
  // the panel asked the server to stop the turn; `over`: the server sent the
  // turn's last event (turn_stopped or an error), so the stream can only end
  | { kind: "stream"; turn: number; conversation: ConversationId; aborted: boolean;
      lost: boolean; started: boolean; stopPosted: boolean; over: boolean }
  | { kind: "confirm"; turn: number; conversation: ConversationId; confirmId: ConfirmId }
  // a stop POST: the hook reports its settling, however it settled, and
  // only once the turn's stream has opened; it may settle long after the
  // stream has ended
  | { kind: "stop"; turn: number });

export type Tally = Map<string, number>;

export type Result = { problems: string[]; trace: string[] };

/** An unchanged entry keeps its identity, as the reducer copies only what
 * it changes. */
function sameEntries(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

class World {
  state: ChatState = initialChat();
  doc: Doc = START;
  reqs: Req[] = [];
  created = new Map<string, AssistantModel>();
  /** reaped, evicted or its harness lost: the server no longer knows it */
  retired = new Set<string>();
  deleted = new Set<string>();
  lostBy = new Set<string>();
  seenTurns = new Set<number>();
  nextId = 0;
  /** a models list with another default arrived while a create was out */
  defaultLanded = false;
  problems: string[] = [];
  trace: string[] = [];

  constructor(readonly machine: Machine, readonly count: (key: string) => void) {}

  fresh(prefix: string): string {
    this.nextId += 1;
    return `${prefix}${this.nextId}`;
  }

  /** The server answers 404 for it. */
  gone(id: string): boolean {
    return this.retired.has(id) || this.deleted.has(id);
  }

  settle(r: Req): void {
    this.reqs = this.reqs.filter((x) => x.key !== r.key);
  }

  /** One reducer step, checked against what the model expects of it. */
  feed(event: ChatEvent, input: Input): void {
    const before = this.machine.view(this.state);
    const { doc, expect } = modelExpect(this.doc, input);
    const out = this.machine.step(this.state, event);
    this.state = out.state;
    const after = this.machine.view(this.state);
    this.trace.push(`${JSON.stringify(event)} -> ${JSON.stringify(out.effects)}`);
    this.doc = this.checkEffects(doc, expect, out.effects, after);
    this.checkView(before, after, expect);
  }

  checkEffects(doc: Doc, ex: Expectation, effects: ChatEffect[], view: View): Doc {
    let next = doc;
    const starts = effects.filter((e) => e.kind === "create" || e.kind === "stream");
    const want = ex.start;
    if (want === null) {
      if (starts.length > 0) this.problems.push(`start: no request expected, got ${JSON.stringify(starts)}`);
    } else {
      const got = starts[0];
      const turnOk = (t: number) => (want.turn === "new" ? !this.seenTurns.has(t) : t === want.turn);
      const match = starts.length === 1 && got.kind === want.kind && turnOk(got.turn)
        && (got.kind === "create" ? want.kind === "create" && got.model === want.model
          : want.kind === "stream" && got.conversation === want.conversation);
      if (!match) {
        this.problems.push(`start: expected ${JSON.stringify(want)}, got ${JSON.stringify(starts)}`);
      } else if (want.turn === "new" && next.busy !== null) {
        next = { ...next, busy: { ...next.busy, turn: got.turn } };
      }
    }
    for (const id of ex.deletes) {
      if (!effects.some((e) => e.kind === "delete" && e.conversation === id)) {
        this.problems.push(`leak: expected a delete of ${id}`);
      }
    }
    for (const t of ex.aborts) {
      if (!effects.some((e) => e.kind === "abort" && e.turn === t)) {
        this.problems.push(`one: expected an abort of turn ${t}`);
      }
    }
    const open = doc.conv.kind === "open" ? doc.conv.id : null;
    for (const t of ex.stops) {
      if (!effects.some((e) => e.kind === "postStop" && e.turn === t && e.conversation === open)) {
        this.problems.push(`stop: expected a stop posted for turn ${t} to ${String(open)}`);
      }
    }
    for (const e of effects) {
      if (e.kind === "postStop" && !ex.stops.includes(e.turn)) {
        this.problems.push(`stop: unexpected ${JSON.stringify(e)}`);
      }
    }
    for (const e of effects) {
      switch (e.kind) {
        case "create":
          this.seenTurns.add(e.turn);
          this.reqs.push({ key: this.nextId++, kind: "create", turn: e.turn, model: e.model });
          break;
        case "stream":
          this.seenTurns.add(e.turn);
          this.reqs.push({ key: this.nextId++, kind: "stream", turn: e.turn, conversation: e.conversation,
                           aborted: false, lost: false, started: false, stopPosted: false,
                           over: false });
          break;
        case "postStop":
          this.reqs = this.reqs.map((r) =>
            (r.kind === "stream" && r.turn === e.turn ? { ...r, stopPosted: true } : r));
          this.reqs.push({ key: this.nextId++, kind: "stop", turn: e.turn });
          break;
        case "abort":
          this.reqs = this.reqs.map((r) =>
            (r.kind === "stream" && r.turn === e.turn ? { ...r, aborted: true } : r));
          break;
        case "delete":
          this.deleted.add(e.conversation);
          break;
        case "confirm": {
          const b = next.busy;
          const open = next.conv.kind === "open" ? next.conv.id : null;
          const head = view.confirms[0]?.confirmId;
          if (!ex.mayConfirm || b === null || e.turn !== b.turn || e.conversation !== open
              || this.reqs.some((r) => r.kind === "confirm" && r.turn === e.turn)) {
            this.problems.push(`confirm: unexpected post ${JSON.stringify(e)}`);
          }
          if (head === undefined || e.confirmId !== head) {
            this.problems.push(`confirm: posted ${e.confirmId}, the head card is ${String(head)}`);
          }
          this.reqs.push({ key: this.nextId++, kind: "confirm", turn: e.turn, conversation: e.conversation,
                           confirmId: e.confirmId });
          break;
        }
      }
    }
    return next;
  }

  checkView(before: View, after: View, ex: Expectation): void {
    const doc = this.doc;
    const itemsMoved = !sameEntries(after.items, before.items);
    const cardsMoved = !sameEntries(after.confirms, before.confirms);
    if (ex.silent && (itemsMoved || cardsMoved || after.error !== before.error)) {
      const what = [itemsMoved ? "items" : "", cardsMoved ? "cards" : "",
                    after.error !== before.error ? `error ${JSON.stringify(after.error)}` : ""]
        .filter(Boolean).join(", ");
      this.problems.push(`silent: a result that must change nothing on screen changed ${what}`);
    }
    if (ex.error === "set" && after.error === null) {
      this.problems.push("error: the busy turn's failure shows no error");
    }
    if (ex.error === "cleared" && after.error !== null) {
      this.problems.push(`error: a send left the error ${JSON.stringify(after.error)}`);
    }
    if (after.model !== shown(doc)) {
      this.problems.push(`picker: shows ${after.model}, the model says ${shown(doc)}` +
        ` (conversation ${JSON.stringify(doc.conv)})`);
    }
    if (after.locked !== (doc.conv.kind !== "none")) {
      this.problems.push(`picker: locked=${after.locked} with conversation ${doc.conv.kind}`);
    }
    if ((after.status === "idle") !== (doc.busy === null)) {
      this.problems.push(`status: ${after.status} while the model's turn is ${JSON.stringify(doc.busy)}`);
    }
    if (doc.busy?.stopped && after.confirms.length > 0) {
      this.problems.push("silent: a card shows after Stop");
    }
    const live = this.reqs.filter((r) => (r.kind === "create" && r.turn === doc.busy?.turn)
      || (r.kind === "stream" && !r.aborted && !r.over));
    if (live.length > 1) this.problems.push(`one: ${live.length} live requests ${JSON.stringify(live)}`);
    for (const r of live) {
      if (r.kind === "stream" && (doc.busy === null || r.turn !== doc.busy.turn)) {
        this.problems.push(`one: a stream of turn ${r.turn} is live, the model's turn is ` +
          `${JSON.stringify(doc.busy)}`);
      }
    }
    const open = doc.conv.kind === "open" ? doc.conv.id : null;
    for (const id of this.created.keys()) {
      if (id !== open && !this.deleted.has(id) && !this.retired.has(id)) {
        this.problems.push(`leak: conversation ${id} is neither open, deleted nor retired`);
      }
    }
  }

  streamEvent(kind: StreamKind): AssistantEvent {
    switch (kind) {
      case "text": return { type: "text_delta", text: "x" };
      case "toolStarted": return { type: "tool_started", tool_use_id: "t1", name: "search", summary: "s" };
      case "toolFinished":
        return { type: "tool_finished", tool_use_id: "t1", name: "search", error: null, declined: false };
      case "phase": return { type: "phase", label: "reasoning" };
      case "confirm":
        return { type: "confirm_request", confirm_id: confirmIdOf(this.fresh("k")),
                 ops_preview: "save_note(...)", preview: null };
      case "turnDone": return { type: "turn_done", usage: null };
      case "error": return { type: "error", message: "boom" };
    }
  }

  /** Delivers a stream's event; turn_stopped and an error are the server's
   * last word on the turn. */
  deliver(r: Extract<Req, { kind: "stream" }>, ev: AssistantEvent, at: number): void {
    const last = ev.type === "turn_stopped" ? "stopped" : ev.type === "error" ? "error" : null;
    this.reqs = this.reqs.map((x) => (x.key === r.key && x.kind === "stream"
      ? { ...x, started: true, over: x.over || last !== null } : x));
    this.feed({ type: "streamEvent", turn: r.turn, event: ev, at },
              { k: "streamEvent", turn: r.turn, last });
  }

  /** The server forgets the conversation; its streams can only end. */
  retire(id: string): void {
    this.retired.add(id);
    this.reqs = this.reqs.map((r) =>
      (r.kind === "stream" && r.conversation === id ? { ...r, lost: true } : r));
  }

  /** Where the busy turn stands relative to a request's turn, for the tally. */
  relation(turn: number): string {
    const b = this.doc.busy;
    if (b === null || b.turn !== turn) return " for a finished or superseded turn";
    if (b.stopped) return b.recreated ? " after stop while re-creating" : " after stop";
    return "";
  }

  settleCreate(r: Extract<Req, { kind: "create" }>, outcome: number): void {
    this.settle(r);
    const landed = this.defaultLanded;
    this.defaultLanded = landed && this.reqs.some((x) => x.kind === "create");
    if (outcome < 80) {
      const id = conversationIdOf(this.fresh("c"));
      this.created.set(id, r.model);
      if (landed) this.count("create resolves after a default landed meanwhile");
      this.count(`create resolves${this.relation(r.turn)}`);
      this.feed({ type: "created", turn: r.turn, id, model: r.model },
                { k: "created", turn: r.turn, id, model: r.model });
      return;
    }
    this.count(`create fails${this.relation(r.turn)}`);
    this.feed({ type: "createFailed", turn: r.turn, message: "cap reached" },
              { k: "createFailed", turn: r.turn });
  }

  settleStream(r: Extract<Req, { kind: "stream" }>, outcome: number, at: number): void {
    const end = () => {
      this.settle(r);
      this.count(`stream ends${this.relation(r.turn)}`);
      this.feed({ type: "streamEnded", turn: r.turn }, { k: "streamEnded", turn: r.turn });
    };
    const event = (kind: StreamKind) => {
      this.count(`stream event${this.relation(r.turn)}${r.aborted ? " (aborted)" : ""}`);
      this.deliver(r, this.streamEvent(kind), at);
    };
    const fail = (failure: "notFound" | "failed" | "aborted") => {
      this.settle(r);
      const label = { notFound: "stream 404", failed: "stream fails", aborted: "abort lands" }[failure];
      this.count(`${label}${this.relation(r.turn)}${
        failure === "notFound" && this.lostBy.has(r.conversation) ? " after a lost harness" : ""}`);
      this.feed({ type: "streamFailed", turn: r.turn,
                  failure: failure === "aborted" ? { kind: "aborted" }
                    : { kind: failure, message: failure === "notFound" ? "unknown conversation"
                      : "network down" } },
                { k: "streamFailed", turn: r.turn, failure });
    };
    if (r.aborted) {
      if (outcome < 70) fail("aborted");
      else if (outcome < 85 && !r.lost && !r.over) event(KINDS[outcome % KINDS.length]);
      else end();
      return;
    }
    if (r.over) return end();
    // the POST to a conversation the server no longer knows is a 404
    if (this.gone(r.conversation) && !r.started) return fail("notFound");
    if (r.lost) return end();
    if (r.stopPosted) {
      // the server drains the stopped turn, then says so; until then an
      // event sent before the stop may still arrive. The hook aborts the
      // stream if the stop POST fails or the server is silent too long.
      if (outcome < 35) {
        this.count(`turn_stopped${this.relation(r.turn)}`);
        this.deliver(r, { type: "turn_stopped" }, at);
        return;
      }
      if (outcome < 50) return event(KINDS[outcome % KINDS.length]);
      if (outcome < 62) {
        this.count(`stop's fallback aborts${this.relation(r.turn)}`);
        this.reqs = this.reqs.map((x) => (x.key === r.key && x.kind === "stream"
          ? { ...x, aborted: true } : x));
        return fail("aborted");
      }
      if (outcome < 72) return end();
      if (outcome < 80) return fail("failed");
      if (outcome < 90) {
        // a stall's interrupt came before the stop
        this.count(`error ends a stopped turn${this.relation(r.turn)}`);
        this.deliver(r, { type: "error", message: "No response from the model" }, at);
        return;
      }
    }
    if (outcome < 53) return event(KINDS[outcome % KINDS.length]);
    if (outcome < 55) {
      // a stop meant for an earlier turn that reached the server late
      this.count(`unasked turn_stopped${this.relation(r.turn)}`);
      this.deliver(r, { type: "turn_stopped" }, at);
      return;
    }
    if (outcome < 67) return end();
    if (outcome < 75) return fail("failed");
    if (outcome < 87) {
      if (r.started) return fail("failed");
      // reaped or evicted just before this POST arrived
      this.retire(r.conversation);
      return fail("notFound");
    }
    // the server's in-band error, then it retires the conversation; the
    // stream itself ends in a later step
    this.retire(r.conversation);
    this.lostBy.add(r.conversation);
    this.count(`harness lost${this.relation(r.turn)}`);
    this.deliver(r, { type: "error", message: HARNESS_LOST }, at);
  }

  settleStop(r: Extract<Req, { kind: "stop" }>): void {
    this.settle(r);
    const streaming = this.reqs.some((x) => x.kind === "stream" && x.turn === r.turn
      && !x.aborted && !x.over);
    this.count(`stop POST settles${streaming ? " before its stream is over" : " late"}` +
      this.relation(r.turn));
    this.feed({ type: "stopSettled", turn: r.turn }, { k: "stopSettled", turn: r.turn });
  }

  settleConfirm(r: Extract<Req, { kind: "confirm" }>, outcome: number, at: number): void {
    this.settle(r);
    if (!this.gone(r.conversation) && outcome < 65) {
      this.count(`confirm posts${this.relation(r.turn)}`);
      this.feed({ type: "confirmPosted", turn: r.turn, conversation: r.conversation,
                  confirmId: r.confirmId, allow: true, at },
                { k: "confirmPosted", turn: r.turn });
      return;
    }
    if (!this.gone(r.conversation) && outcome >= 85) this.retire(r.conversation);
    const notFound = this.gone(r.conversation);
    this.count(`confirm ${notFound ? "404" : "fails"}${this.relation(r.turn)}`);
    this.feed({ type: "confirmFailed", turn: r.turn, confirmId: r.confirmId, notFound,
                message: notFound ? "unknown conversation" : "network down" },
              { k: "confirmFailed", turn: r.turn, notFound });
  }

  act(a: Action, at: number): boolean {
    switch (a.a) {
      case "send": {
        const busy = this.doc.busy;
        const conv = this.doc.conv;
        if (busy !== null) this.count(`send while busy (${busy.stage})`);
        else if (!a.blank && conv.kind === "open" && this.gone(conv.id)) {
          this.count(this.lostBy.has(conv.id) ? "send after a lost harness" : "send after a reap");
        }
        this.feed({ type: "send", text: a.blank ? "  " : "hi", at }, { k: "send", blank: a.blank });
        return true;
      }
      case "stop": {
        const b = this.doc.busy;
        if (b !== null && !b.stopped) {
          this.count(b.stage === "streaming" ? "stop while streaming"
            : b.recreated ? "stop while re-creating" : "stop while creating");
        }
        this.feed({ type: "stop", at }, { k: "stop" });
        return true;
      }
      case "newChat":
        this.count(`new chat with conversation ${this.doc.conv.kind}`);
        this.feed({ type: "newChat" }, { k: "newChat" });
        return true;
      case "pick":
        this.count(`pick with conversation ${this.doc.conv.kind}`);
        this.feed({ type: "pickModel", model: a.model }, { k: "pick", model: a.model });
        return true;
      case "modelsLoaded":
        this.count(`models load with conversation ${this.doc.conv.kind}`);
        if (this.doc.conv.kind === "creating" && a.default !== this.doc.conv.model) {
          this.defaultLanded = true;
        }
        this.feed({ type: "modelsLoaded", models: ["sonnet", "opus", "haiku", "fable"], default: a.default },
                  { k: "modelsLoaded", default: a.default });
        return true;
      case "answer": {
        const head = this.machine.view(this.state).confirms[0]?.confirmId;
        if (head === undefined) return false;
        this.feed({ type: "answer", confirmId: a.stale ? confirmIdOf("stale") : head, allow: a.allow },
                  { k: "answer" });
        return true;
      }
      case "server": {
        if (this.reqs.length === 0) return false;
        const r = this.reqs[a.pick % this.reqs.length];
        if (r.kind === "create") this.settleCreate(r, a.outcome);
        else if (r.kind === "stream") this.settleStream(r, a.outcome, at);
        else if (r.kind === "stop") this.settleStop(r);
        else this.settleConfirm(r, a.outcome, at);
        return true;
      }
      case "reap": {
        // idle reaping or eviction: never a conversation with a turn running
        const ids = [...this.created.keys()].filter((id) => !this.gone(id)
          && !this.reqs.some((r) => r.kind === "stream" && r.conversation === id));
        if (ids.length === 0) return false;
        this.retire(ids[a.pick % ids.length]);
        return true;
      }
    }
  }
}

/** Runs the actions in order; an action with nothing to act on (no request
 * outstanding, no card to answer, nothing to reap) is skipped and tallied. */
export function runActions(actions: readonly Action[], machine: Machine = REAL,
                           tally?: Tally): Result {
  const count = (key: string) => { tally?.set(key, (tally.get(key) ?? 0) + 1); };
  const world = new World(machine, count);
  actions.forEach((a, i) => {
    if (world.problems.length > 0) return;
    if (!world.act(a, i)) count(`skipped ${a.a}`);
  });
  return { problems: world.problems, trace: world.trace };
}
