// pattern: Imperative Shell
// Runs one drawn action list against the real chat driver (chatDriver.ts)
// with a fake ChatClient whose every request waits until an action settles
// it, on vitest's fake setTimeout, clearTimeout and Date: the caller installs
// them (driver.prop.ts). After each action the microtasks drain, and what the
// driver did (each state it published, each request it sent, each abort it
// signalled) is read back in order and judged.
//
// The pure machine is the reference for what the driver runs: a shadow copy
// is stepped with the user's actions and with the results the fake's
// settling implies, naming the turn each request was made for. The I/O
// order around it is modelled from frontend.md § The chat machine. Each
// problem names its invariant first:
//
//   agree    every state the driver publishes is the machine's step on a
//            result owed to it, each dispatched once, within the action that
//            owed it; so no event of an old stream reaches a later turn, and a
//            stop counts as settled only once its POST has
//   run      each create, stream and confirm the machine asks for is sent at
//            once, with its arguments, and the driver sends no other
//   retry    a stream is sent again only after a 409, while its turn still
//            streams: never after Stop or New chat
//   one      at most one stream is live (sent, not settled, not aborted, not
//            past its last event), and it is the busy turn's
//   stop     a stopped turn's stop POST goes out only while its stream's
//            response is open, as soon as it opens, at most once, and never
//            for a stream that settled first
//   fallback a failed stop POST aborts the turn's stream; once
//            STOP_ACK_TIMEOUT_MS has passed since Stop, the turn's stream and
//            stop POST, whichever is still open, are aborted
//   abort    a stream or stop POST is aborted only by the machine's abort, a
//            failed stop POST or a passed deadline, and the machine's abort
//            reaches the stream at once
//   delete   no DELETE goes out while a stream to that conversation is open
//            and has not sent its last word; every DELETE the machine asks
//            for goes out, at once or as soon as New chat's aborted stream
//            has settled
//   quiet    settling everything benignly leaves nothing outstanding
import { afterEach, beforeEach, vi } from "vitest";
import { ApiError } from "../../api/client";
import type { ConfirmId, ConversationId } from "../../api/brands";
import {
  createChatDriver, STOP_ACK_TIMEOUT_MS, type ChatClient, type ChatDriver,
} from "../../assistant/chatDriver";
import { step, type ChatEvent, type ChatState, type TurnId } from "../../assistant/chatMachine";
import type { AssistantModel } from "../../assistant/client";
import type { AssistantEvent } from "../../assistant/sse";
import { confirmIdOf, conversationIdOf } from "../../test-helpers";
import { bump, type Tally } from "../reach";
import type { DriverAction } from "./driverArbitraries";

/** The seam the teeth swap a broken driver through. */
export type MakeDriver = (publish: (s: ChatState) => void, client: ChatClient) => ChatDriver;

export const REAL_DRIVER: MakeDriver = createChatDriver;

type Settle = { settled: boolean; reject: (err: unknown) => void; turn: TurnId | null };

type CreateCall = Settle & { kind: "create"; key: number; model: AssistantModel;
                             resolve: (c: { id: ConversationId; model: AssistantModel }) => void };
/** `unsent`: called with its signal already aborted, so, like fetch, it
 * rejects at once and never reaches the server. */
type StreamCall = Settle & { kind: "stream"; key: number; conv: ConversationId; text: string;
                             onEvent: (ev: AssistantEvent) => void; onOpen: () => void;
                             resolve: () => void; opened: boolean; over: boolean; aborted: boolean;
                             unsent: boolean };
/** `streams`: each stream's state when this POST was sent. */
type StopCall = Settle & { kind: "stop"; key: number; conv: ConversationId; resolve: () => void;
                           aborted: boolean;
                           streams: Map<number, { opened: boolean; settled: boolean }> };
/** `open`: the streams to its conversation open, short of their last word,
 * when this DELETE was sent. */
type DeleteCall = Settle & { kind: "delete"; key: number; conv: ConversationId; resolve: () => void;
                             open: number[] };
type ConfirmCall = Settle & { kind: "confirm"; key: number; conv: ConversationId; confirmId: ConfirmId;
                              allow: boolean; resolve: () => void };
type Call = CreateCall | StreamCall | StopCall | DeleteCall | ConfirmCall;

/** What the driver did, in order, between two judgements. */
type Entry =
  | { e: "publish"; state: ChatState }
  | { e: "call"; call: Call }
  | { e: "abort"; call: StreamCall | StopCall; at: number };

/** One turn's requests as the run has seen them. `streamDone`: its latest
 * stream has settled with no retry to follow. */
type TurnRec = {
  streams: StreamCall[];
  streamDone: boolean;
  abortAsked: boolean;
  stop: null | { conv: ConversationId; deadline: number; call: StopCall | null; failed: boolean;
                 noPost: boolean; openedLate: boolean };
};

export type DriverResult = { problems: string[]; trace: string[] };

const SERVER_KINDS = ["text", "toolStarted", "toolFinished", "phase", "confirm", "confirm",
                      "turnDone", "error"] as const;
type ServerKind = typeof SERVER_KINDS[number];

const BUSY = "conversation busy";
const UNKNOWN = "unknown conversation";
const DOWN = "network down";

const abortError = () => new DOMException("The operation was aborted.", "AbortError");
const flush = () => new Promise<void>((resolve) => { setImmediate(resolve); });
const key = (s: ChatState) => JSON.stringify(s);

class DriverWorld {
  readonly driver: ChatDriver;
  shadow: ChatState;
  log: Entry[] = [];
  calls: Call[] = [];
  owed: ChatEvent[] = [];
  /** a 409 the driver may answer with a retry or with this failure */
  busy = new Map<TurnId, { conv: ConversationId; text: string; event: ChatEvent }>();
  expected: Extract<ReturnType<typeof step>["effects"][number],
                    { kind: "create" | "stream" | "confirm" }>[] = [];
  deletes: { conv: ConversationId; after: TurnId | null; sent: boolean }[] = [];
  mustAbort: TurnId[] = [];
  turns = new Map<TurnId, TurnRec>();
  problems: string[] = [];
  trace: string[] = [];
  nextKey = 0;
  counting = true;

  constructor(make: MakeDriver, readonly tally: Tally | undefined) {
    this.driver = make((s) => { this.log.push({ e: "publish", state: s }); }, this.client());
    this.shadow = this.driver.current();
  }

  count(label: string): void {
    if (this.counting && this.tally) bump(this.tally, label);
  }

  rec(turn: TurnId): TurnRec {
    let r = this.turns.get(turn);
    if (r === undefined) {
      r = { streams: [], streamDone: false, abortAsked: false, stop: null };
      this.turns.set(turn, r);
    }
    return r;
  }

  latest(turn: TurnId): StreamCall | undefined {
    const s = this.turns.get(turn)?.streams;
    return s?.[s.length - 1];
  }

  busyTurn(): TurnId | null {
    return this.shadow.turn.phase === "idle" ? null : this.shadow.turn.id;
  }

  streaming(turn: TurnId): boolean {
    return this.shadow.turn.phase === "streaming" && this.shadow.turn.id === turn;
  }

  /** The turn's stream has settled for good: a stop not yet posted never
   * will be, and settles now. */
  streamDone(turn: TurnId): void {
    const r = this.rec(turn);
    r.streamDone = true;
    if (r.stop !== null && r.stop.call === null && !r.stop.noPost) {
      r.stop.noPost = true;
      this.count("stop posts nothing: the stream settled first");
      this.owed.push({ type: "stopSettled", turn });
    }
  }

  client(): ChatClient {
    const push = <C extends Call>(call: C): C => {
      this.calls.push(call);
      this.log.push({ e: "call", call });
      return call;
    };
    return {
      createConversation: (model) => new Promise((resolve, reject) => {
        push<CreateCall>({ kind: "create", key: this.nextKey++, model: model as AssistantModel,
                           settled: false, turn: null, resolve, reject });
      }),
      streamMessage: (conv, text, onEvent, signal, onOpen) => new Promise<void>((resolve, reject) => {
        const call = push<StreamCall>({
          kind: "stream", key: this.nextKey++, conv, text, onEvent, onOpen: onOpen ?? (() => {}),
          resolve, reject, settled: false, turn: null, opened: false, over: false,
          aborted: false, unsent: signal?.aborted ?? false,
        });
        if (call.unsent) {
          this.unsent(call);
          return;
        }
        signal?.addEventListener("abort", () => {
          if (call.settled) return;
          call.aborted = true;
          this.log.push({ e: "abort", call, at: Date.now() });
        });
      }),
      stopTurn: (conv, signal) => new Promise<void>((resolve, reject) => {
        const streams = new Map(this.calls.filter((c): c is StreamCall => c.kind === "stream")
          .map((c) => [c.key, { opened: c.opened, settled: c.settled }]));
        const call = push<StopCall>({ kind: "stop", key: this.nextKey++, conv, resolve, reject,
                                      settled: false, turn: null, aborted: false, streams });
        signal?.addEventListener("abort", () => {
          if (call.settled) return;
          call.aborted = true;
          this.log.push({ e: "abort", call, at: Date.now() });
        });
      }),
      deleteConversation: (conv) => new Promise<void>((resolve, reject) => {
        const open = this.calls.filter((c): c is StreamCall => c.kind === "stream"
          && c.conv === conv && !c.settled && !c.over).map((c) => c.key);
        push<DeleteCall>({ kind: "delete", key: this.nextKey++, conv, resolve, reject,
                           settled: false, turn: null, open });
      }),
      confirmTool: (conv, confirmId, allow) => new Promise<void>((resolve, reject) => {
        push<ConfirmCall>({ kind: "confirm", key: this.nextKey++, conv, confirmId, allow, resolve,
                            reject, settled: false, turn: null });
      }),
    };
  }

  /** A retry whose signal was aborted during its back-off: it belongs to
   * the turn whose 409 it answers, and rejects as fetch would. */
  unsent(call: StreamCall): void {
    const entry = [...this.busy].find(([, b]) => b.conv === call.conv && b.text === call.text);
    call.settled = true;
    call.reject(abortError());
    if (entry === undefined) return;
    const [turn] = entry;
    this.busy.delete(turn);
    call.turn = turn;
    this.rec(turn).streams.push(call);
    this.count("a retry whose back-off was aborted is never sent");
    this.owed.push({ type: "streamFailed", turn, failure: { kind: "aborted" } });
    this.streamDone(turn);
  }

  // ---- the user's actions -------------------------------------------------

  dispatch(event: ChatEvent): void {
    this.owed.unshift(event);
    void this.driver.dispatch(event);
  }

  // ---- settling the fake's requests ---------------------------------------

  serverEvent(kind: ServerKind): AssistantEvent {
    switch (kind) {
      case "text": return { type: "text_delta", text: "x" };
      case "toolStarted": return { type: "tool_started", tool_use_id: "t1", name: "search", summary: "s" };
      case "toolFinished":
        return { type: "tool_finished", tool_use_id: "t1", error: null, declined: false };
      case "phase": return { type: "phase", label: "reasoning" };
      case "confirm":
        return { type: "confirm_request", confirm_id: confirmIdOf(`k${this.nextKey++}`), preview: null };
      case "turnDone": return { type: "turn_done", usage: null };
      case "error": return { type: "error", message: "boom" };
    }
  }

  /** Where the stream's turn stands, for the tally. */
  relation(turn: TurnId): string {
    if (this.busyTurn() === turn) return this.shadow.turn.phase === "stopping" ? " after stop" : "";
    return this.busyTurn() === null ? " for an ended turn" : " during a later turn";
  }

  deliver(s: StreamCall, ev: AssistantEvent): void {
    const turn = s.turn ?? -1;
    if (ev.type === "turn_stopped" || ev.type === "error") s.over = true;
    if (this.busyTurn() !== turn) {
      this.count(`an old stream's event${this.relation(turn)}` +
        `${this.shadow.conversation.kind === "open" && this.shadow.conversation.id === s.conv
          ? "" : " in another chat"}`);
    }
    this.owed.push({ type: "streamEvent", turn, event: ev, at: Date.now() });
    s.onEvent(ev);
  }

  failStream(s: StreamCall, err: "abort" | "busy" | "notFound" | "down"): void {
    const turn = s.turn ?? -1;
    s.settled = true;
    switch (err) {
      case "abort":
        this.count(`abort lands${this.relation(turn)}`);
        this.owed.push({ type: "streamFailed", turn, failure: { kind: "aborted" } });
        this.streamDone(turn);
        s.reject(abortError());
        return;
      case "busy": {
        const event: ChatEvent = { type: "streamFailed", turn,
                                   failure: { kind: "failed", message: BUSY } };
        if (this.streaming(turn)) {
          this.count("409 while streaming");
          this.busy.set(turn, { conv: s.conv, text: s.text, event });
        } else {
          this.count(`409${this.relation(turn)}`);
          this.owed.push(event);
          this.streamDone(turn);
        }
        s.reject(new ApiError(409, "/messages", BUSY));
        return;
      }
      case "notFound":
        this.count(`stream 404${this.relation(turn)}`);
        this.owed.push({ type: "streamFailed", turn, failure: { kind: "notFound", message: UNKNOWN } });
        this.streamDone(turn);
        s.reject(new ApiError(404, "/messages", UNKNOWN));
        return;
      case "down":
        this.count(`stream fails${this.relation(turn)}`);
        this.owed.push({ type: "streamFailed", turn, failure: { kind: "failed", message: DOWN } });
        this.streamDone(turn);
        s.reject(new TypeError(DOWN));
        return;
    }
  }

  endStream(s: StreamCall): void {
    const turn = s.turn ?? -1;
    s.settled = true;
    this.count(`stream ends${this.relation(turn)}${s.aborted ? " (aborted)" : ""}`);
    this.owed.push({ type: "streamEnded", turn });
    this.streamDone(turn);
    s.resolve();
  }

  settleStream(s: StreamCall, outcome: number): void {
    const turn = s.turn ?? -1;
    const posted = this.turns.get(turn)?.stop?.call != null;
    if (s.aborted) {
      if (!s.opened || outcome < 50) return this.failStream(s, "abort");
      if (outcome < 80 && !s.over) {
        this.count("an aborted stream still delivers an event");
        return this.deliver(s, this.serverEvent(SERVER_KINDS[outcome % SERVER_KINDS.length]));
      }
      return this.endStream(s);
    }
    if (!s.opened) {
      if (outcome < 55) {
        s.opened = true;
        const stop = this.turns.get(turn)?.stop;
        if (stop != null && stop.call === null) stop.openedLate = true;
        this.count(`stream opens${this.relation(turn)}`);
        s.onOpen();
        return;
      }
      if (outcome < 70) return this.failStream(s, "busy");
      if (outcome < 85) return this.failStream(s, "notFound");
      return this.failStream(s, "down");
    }
    if (s.over) return outcome < 80 ? this.endStream(s) : this.failStream(s, "down");
    if (posted && outcome < 35) {
      this.count("turn_stopped after a posted stop");
      return this.deliver(s, { type: "turn_stopped" });
    }
    if (outcome < 60) return this.deliver(s, this.serverEvent(SERVER_KINDS[outcome % SERVER_KINDS.length]));
    if (outcome < 63) {
      this.count(`unasked turn_stopped${posted ? " after a posted stop" : ""}`);
      return this.deliver(s, { type: "turn_stopped" });
    }
    if (outcome < 85) return this.endStream(s);
    return this.failStream(s, "down");
  }

  settleStop(c: StopCall, outcome: number): void {
    const turn = c.turn ?? -1;
    c.settled = true;
    this.owed.push({ type: "stopSettled", turn });
    if (c.aborted) {
      this.count(`stop POST settles after its abort${this.relation(turn)}`);
      if (outcome < 70) c.reject(abortError());
      else c.resolve();
      return;
    }
    if (outcome < 70) {
      this.count(`stop POST answers${this.relation(turn)}`);
      c.resolve();
      return;
    }
    this.count(`stop POST fails${this.relation(turn)}`);
    const stop = this.turns.get(turn)?.stop;
    if (stop != null) stop.failed = true;
    c.reject(new ApiError(502, "/stop", DOWN));
  }

  settleCall(c: Call, outcome: number): void {
    switch (c.kind) {
      case "create": {
        c.settled = true;
        const turn = c.turn ?? -1;
        if (outcome < 80) {
          const id = conversationIdOf(`c${this.nextKey++}`);
          this.count(`create resolves${this.relation(turn)}`);
          this.owed.push({ type: "created", turn, id, model: c.model });
          c.resolve({ id, model: c.model });
          return;
        }
        this.count(`create fails${this.relation(turn)}`);
        this.owed.push({ type: "createFailed", turn, message: "cap reached" });
        c.reject(new ApiError(409, "/conversations", "cap reached"));
        return;
      }
      case "stream":
        return this.settleStream(c, outcome);
      case "stop":
        return this.settleStop(c, outcome);
      case "delete":
        c.settled = true;
        this.count("DELETE settles");
        if (outcome < 80) c.resolve();
        else c.reject(new ApiError(502, "/conversations", DOWN));
        return;
      case "confirm": {
        c.settled = true;
        const turn = c.turn ?? -1;
        const at = Date.now();
        if (outcome < 65) {
          this.count(`confirm posts${this.relation(turn)}`);
          this.owed.push({ type: "confirmPosted", turn, conversation: c.conv, confirmId: c.confirmId,
                           allow: c.allow, at });
          c.resolve();
          return;
        }
        const notFound = outcome >= 85;
        this.count(`confirm ${notFound ? "404" : "fails"}${this.relation(turn)}`);
        this.owed.push({ type: "confirmFailed", turn, confirmId: c.confirmId, notFound,
                         message: notFound ? UNKNOWN : DOWN });
        c.reject(new ApiError(notFound ? 404 : 502, "/confirm", notFound ? UNKNOWN : DOWN));
        return;
      }
    }
  }

  act(a: DriverAction, i: number): boolean {
    switch (a.a) {
      case "send": {
        if (this.busyTurn() !== null) this.count("send while busy");
        this.dispatch({ type: "send", text: a.blank ? "  " : `m${i}`, at: Date.now() });
        return true;
      }
      case "stop": {
        const t = this.shadow.turn;
        if (t.phase === "creating") this.count("stop while creating");
        if (t.phase === "streaming") {
          const s = this.latest(t.id);
          this.count(this.busy.has(t.id) ? "stop during a 409's back-off"
            : s?.opened === true && !s.settled ? "stop while the stream is open"
              : "stop before the stream opens");
        }
        this.dispatch({ type: "stop", at: Date.now() });
        return true;
      }
      case "newChat": {
        const t = this.shadow.turn;
        if (t.phase !== "idle") {
          this.count(`new chat while ${t.phase}${this.busy.has(t.id) ? " in a 409's back-off" : ""}`);
        }
        this.dispatch({ type: "newChat" });
        return true;
      }
      case "answer": {
        const head = this.shadow.confirms[0];
        if (head === undefined) return false;
        this.count("answer");
        this.dispatch({ type: "answer", confirmId: head.confirmId, allow: a.allow });
        return true;
      }
      case "settle": {
        const open = this.calls.filter((c) => !c.settled);
        if (open.length === 0) return false;
        this.settleCall(open[a.pick % open.length], a.outcome);
        return true;
      }
      case "tick": {
        if (vi.getTimerCount() === 0) return false;
        const before = Date.now();
        if (a.to === "next") vi.advanceTimersToNextTimer();
        else vi.advanceTimersByTime(STOP_ACK_TIMEOUT_MS);
        for (const [turn, r] of this.turns) {
          if (r.stop !== null && r.stop.deadline > before && r.stop.deadline <= Date.now()) {
            const s = this.latest(turn);
            const open = (s !== undefined && !s.settled) || (r.stop.call !== null && !r.stop.call.settled);
            this.count(open ? "the stop's deadline passes with the turn still open"
              : "the stop's deadline passes with nothing open");
          }
        }
        return true;
      }
    }
  }

  // ---- judging what the driver did ----------------------------------------

  problem(text: string): void {
    this.problems.push(text);
  }

  /** Reads the log in order, then checks what must hold at the end of a
   * flush. */
  judge(): void {
    const log = this.log;
    this.log = [];
    for (const entry of log) {
      if (this.problems.length > 0) return;
      if (entry.e === "publish") this.publish(entry.state);
      else if (entry.e === "call") this.call(entry.call);
      else this.aborted(entry.call, entry.at);
    }
    if (this.problems.length > 0) return;
    this.endOfFlush();
  }

  publish(state: ChatState): void {
    const want = key(state);
    for (const [i, event] of this.owed.entries()) {
      const out = step(this.shadow, event);
      if (key(out.state) !== want) continue;
      this.owed.splice(i, 1);
      this.apply(event, out);
      return;
    }
    for (const [turn, b] of this.busy) {
      const out = step(this.shadow, b.event);
      if (key(out.state) !== want) continue;
      this.busy.delete(turn);
      this.count("a 409 fails the turn");
      this.apply(b.event, out);
      this.streamDone(turn);
      return;
    }
    this.problem(`agree: the driver published a state no owed result explains;` +
      ` owed ${JSON.stringify(this.owed)}, 409s ${JSON.stringify([...this.busy.keys()])};` +
      ` published turn ${JSON.stringify(state.turn)}, items ${state.items.length},` +
      ` error ${JSON.stringify(state.error)}; the machine's turn ${JSON.stringify(this.shadow.turn)}`);
  }

  apply(event: ChatEvent, out: ReturnType<typeof step>): void {
    this.trace.push(`${JSON.stringify(event)} -> ${JSON.stringify(out.effects)}`);
    this.shadow = out.state;
    for (const e of out.effects) {
      switch (e.kind) {
        case "create": case "stream": case "confirm":
          this.expected.push(e);
          break;
        case "abort": {
          const r = this.rec(e.turn);
          r.abortAsked = true;
          this.mustAbort.push(e.turn);
          break;
        }
        case "postStop": {
          const r = this.rec(e.turn);
          r.stop = { conv: e.conversation, deadline: Date.now() + STOP_ACK_TIMEOUT_MS, call: null,
                     failed: false, noPost: false, openedLate: false };
          if (r.streamDone) this.streamDone(e.turn);
          break;
        }
        case "delete": {
          if (e.after !== null) {
            const s = this.latest(e.after);
            this.count(s !== undefined && !s.settled ? "new chat's DELETE waits for the aborted stream"
              : "new chat's DELETE goes at once");
          } else if (this.shadow.conversation.kind !== "open"
                     || this.shadow.conversation.id !== e.conversation) {
            this.count(event.type === "created" ? "DELETE of a conversation made for a superseded turn"
              : "new chat's DELETE goes at once");
          }
          this.deletes.push({ conv: e.conversation, after: e.after, sent: false });
          break;
        }
      }
    }
  }

  call(c: Call): void {
    switch (c.kind) {
      case "create": {
        const i = this.expected.findIndex((e) => e.kind === "create" && e.model === c.model);
        if (i < 0) return this.problem(`run: a create for ${c.model} the machine never asked for`);
        c.turn = this.expected[i].turn;
        this.expected.splice(i, 1);
        return;
      }
      case "stream": {
        if (c.unsent) {
          if (c.turn === null) this.problem(`run: a stream to ${c.conv} answering no 409`);
          return;
        }
        const i = this.expected.findIndex((e) => e.kind === "stream" && e.conversation === c.conv
          && e.text === c.text);
        if (i >= 0) {
          const turn = this.expected[i].turn;
          this.expected.splice(i, 1);
          c.turn = turn;
          const r = this.rec(turn);
          r.streams.push(c);
          r.streamDone = false;
          if (this.calls.some((o) => o.kind === "stream" && o.conv === c.conv && o.over && !o.settled)) {
            this.count("a stream starts while the last one's body is still open");
          }
          return;
        }
        const retry = [...this.busy].find(([, b]) => b.conv === c.conv && b.text === c.text);
        if (retry === undefined) {
          return this.problem(`run: a stream to ${c.conv} (${c.text}) the machine never asked for`);
        }
        const [turn] = retry;
        this.busy.delete(turn);
        c.turn = turn;
        this.rec(turn).streams.push(c);
        if (!this.streaming(turn)) {
          return this.problem(`retry: turn ${turn}'s 409 was retried after its turn left` +
            ` streaming (${JSON.stringify(this.shadow.turn)})`);
        }
        this.count("a 409 is retried");
        return;
      }
      case "stop": {
        // the latest Stop to this conversation that has posted nothing
        const entry = [...this.turns].reverse().find(([, r]) => r.stop !== null
          && r.stop.conv === c.conv && r.stop.call === null);
        if (entry === undefined) {
          return this.problem(`stop: a stop POST to ${c.conv} no Stop asked for, or a second one`);
        }
        const [turn, r] = entry;
        const stop = r.stop;
        if (stop === null) return;
        stop.call = c;
        c.turn = turn;
        const s = this.latest(turn);
        const then = s === undefined ? undefined : c.streams.get(s.key);
        if (then === undefined || !then.opened || then.settled) {
          return this.problem(`stop: turn ${turn}'s stop was posted while its stream was` +
            ` ${then === undefined ? "not sent" : then.settled ? "settled" : "not yet open"}`);
        }
        this.count(stop.openedLate ? "stop posted once the stream opened" : "stop posted at once");
        return;
      }
      case "delete": {
        const d = this.deletes.find((x) => x.conv === c.conv && !x.sent);
        if (d === undefined) return this.problem(`delete: a DELETE of ${c.conv} nothing asked for`);
        d.sent = true;
        if (c.open.length > 0) {
          return this.problem(`delete: the DELETE of ${c.conv} went out while its stream` +
            ` ${c.open.join(", ")} was still open`);
        }
        if (d.after !== null && this.latest(d.after)?.aborted === true) {
          this.count("DELETE sent once the aborted stream settled");
        }
        return;
      }
      case "confirm": {
        const i = this.expected.findIndex((e) => e.kind === "confirm" && e.conversation === c.conv
          && e.confirmId === c.confirmId && e.allow === c.allow);
        if (i < 0) return this.problem(`run: a confirm POST the machine never asked for`);
        c.turn = this.expected[i].turn;
        this.expected.splice(i, 1);
        return;
      }
    }
  }

  aborted(c: StreamCall | StopCall, at: number): void {
    const turn = c.turn;
    if (turn === null) return this.problem(`abort: a request of no turn was aborted`);
    const r = this.rec(turn);
    const passed = r.stop !== null && at >= r.stop.deadline;
    const failed = r.stop?.failed === true;
    const ok = c.kind === "stream" ? r.abortAsked || failed || passed : failed || passed;
    if (!ok) {
      return this.problem(`abort: turn ${turn}'s ${c.kind === "stream" ? "stream" : "stop POST"} was` +
        ` aborted with no abort asked, no failed stop and ${r.stop === null ? "no Stop"
          : `${r.stop.deadline - at} ms before the stop's deadline`}`);
    }
    if (!r.abortAsked) {
      this.count(`fallback aborts the ${c.kind === "stream" ? "stream" : "stop POST"}` +
        ` (${failed ? "the stop POST failed" : "the deadline passed"})`);
    }
  }

  endOfFlush(): void {
    for (const e of this.expected) {
      this.problem(`run: the machine asked for ${JSON.stringify(e)}; the driver never sent it`);
    }
    this.expected = [];
    for (const e of this.owed) {
      this.problem(`agree: the driver never dispatched ${JSON.stringify(e)}`);
    }
    for (const turn of this.mustAbort) {
      const s = this.latest(turn);
      if (s !== undefined && !s.settled && !s.aborted) {
        this.problem(`abort: the machine aborted turn ${turn}; its stream is still open`);
      }
    }
    this.mustAbort = [];
    const now = Date.now();
    for (const [turn, r] of this.turns) {
      const stop = r.stop;
      if (stop === null) continue;
      const s = this.latest(turn);
      if (stop.call === null && !stop.noPost && s !== undefined && s.opened && !s.settled) {
        this.problem(`stop: turn ${turn}'s stream is open and no stop was posted`);
      }
      const streamOpen = s !== undefined && !s.settled && !s.aborted;
      if (stop.failed && streamOpen) {
        this.problem(`fallback: turn ${turn}'s stop POST failed and its stream was not aborted`);
      }
      if (now >= stop.deadline && this.busyTurn() === turn) {
        if (streamOpen) {
          this.problem(`fallback: STOP_ACK_TIMEOUT_MS passed since turn ${turn}'s Stop and its` +
            ` stream was not aborted`);
        }
        if (stop.call !== null && !stop.call.settled && !stop.call.aborted) {
          this.problem(`fallback: STOP_ACK_TIMEOUT_MS passed since turn ${turn}'s Stop and its` +
            ` stop POST was not aborted`);
        }
      }
    }
    for (const d of this.deletes) {
      if (d.sent) continue;
      if (d.after === null || this.rec(d.after).streamDone) {
        this.problem(`delete: the DELETE of ${d.conv} was not sent though` +
          ` ${d.after === null ? "it waits on nothing" : `turn ${d.after}'s stream has settled`}`);
      }
    }
    const live = this.calls.filter((c): c is StreamCall => c.kind === "stream" && !c.settled
      && !c.aborted && !c.over);
    if (live.length > 1) {
      this.problem(`one: ${live.length} live streams (turns ${live.map((c) => c.turn).join(", ")})`);
    }
    for (const c of live) {
      if (c.turn !== this.busyTurn()) {
        this.problem(`one: turn ${c.turn}'s stream is live; the busy turn is ${this.busyTurn()}`);
      }
    }
    if (key(this.driver.current()) !== key(this.shadow)) {
      this.problem("agree: the driver's state is not the machine's");
    }
  }

  /** Settles everything with benign outcomes and fires every timer. */
  async quiesce(): Promise<void> {
    this.counting = false;
    for (let round = 0; round < 60; round += 1) {
      const open = this.calls.find((c) => !c.settled);
      if (open !== undefined) {
        // 70 ends an open stream; 0 opens one, and resolves anything else
        const ends = open.kind === "stream" && open.opened && !open.over && !open.aborted;
        this.settleCall(open, ends ? 70 : 0);
      } else if (vi.getTimerCount() > 0) {
        vi.advanceTimersToNextTimer();
      } else {
        break;
      }
      await flush();
      this.judge();
      if (this.problems.length > 0) return;
    }
    const left = this.calls.filter((c) => !c.settled);
    if (left.length > 0 || vi.getTimerCount() > 0 || this.busy.size > 0) {
      this.problem(`quiet: still outstanding after settling: ${left.map((c) => c.kind).join(", ")},` +
        ` ${vi.getTimerCount()} timers, ${this.busy.size} 409s`);
    }
    for (const d of this.deletes) {
      if (!d.sent) this.problem(`delete: the DELETE of ${d.conv} the machine asked for was never sent`);
    }
  }
}

/** Installs the fake clock the run needs, around each test of the calling
 * file: the driver's timers (its stop fallback and its 409 back-off) and
 * Date.now. fast-check and the gate's give-way keep the real ones. */
export function fakeDriverClock(): void {
  beforeEach(() => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] }); });
  afterEach(() => { vi.useRealTimers(); });
}

/** Runs the actions in order on the clock `fakeDriverClock` installs; an
 * action with nothing to act on is skipped and tallied. */
export async function runDriverActions(actions: readonly DriverAction[],
                                       make: MakeDriver = REAL_DRIVER,
                                       tally?: Tally): Promise<DriverResult> {
  vi.clearAllTimers();
  const world = new DriverWorld(make, tally);
  try {
    for (const [i, a] of actions.entries()) {
      if (!world.act(a, i)) world.count(`skipped ${a.a}`);
      await flush();
      world.judge();
      if (world.problems.length > 0) break;
    }
    if (world.problems.length === 0) await world.quiesce();
  } finally {
    vi.clearAllTimers();
  }
  return { problems: world.problems, trace: world.trace };
}
