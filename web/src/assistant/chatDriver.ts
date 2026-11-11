// pattern: Imperative Shell
// Runs the assistant panel's chat machine (chatMachine.ts): dispatches each
// event into it, publishes the new state, and starts the requests its
// effects name through the client it is given, whose results come back as
// events.

import { ApiError } from "../api/client";
import type { ConversationId } from "../api/brands";
import type {
  confirmTool,
  createConversation,
  deleteConversation,
  stopTurn,
  streamMessage,
} from "./client";
import {
  initialChat,
  step,
  turnBusy,
  type ChatEffect,
  type ChatEvent,
  type ChatState,
  type StreamFailure,
  type TurnId,
} from "./chatMachine";
import type { AssistantEvent } from "./sse";

/** ApiError carries the server's `detail` message; prefer
 * it over the generic "request failed: <status> <path>" wrapper text. */
function friendlyMessage(err: unknown): string {
  if (err instanceof ApiError && err.detail) return err.detail;
  return err instanceof Error ? err.message : String(err);
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

function isBusyError(err: unknown): boolean {
  return err instanceof ApiError && err.status === 409;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// An aborted fetch rejects at once, before the server has noticed the
// dropped connection and released the conversation's busy flag (the
// reservation in service.py's `send`), and the busy flag clears a few loop
// passes after a stopped turn's last event. Sending again in either window
// can see a 409. Retrying briefly closes it without changing the contract
// for a *sustained* busy conflict, which still surfaces as an error once
// these short retries are exhausted. A stopped turn retries nothing.
const BUSY_RETRY_ATTEMPTS = 5;
const BUSY_RETRY_DELAY_MS = 60;

async function streamWithBusyRetry(
  stream: ChatClient["streamMessage"],
  id: ConversationId,
  text: string,
  onEvent: (ev: AssistantEvent) => void,
  signal: AbortSignal,
  onOpen: () => void,
  keepTrying: () => boolean,
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await stream(id, text, onEvent, signal, onOpen);
      return;
    } catch (err) {
      if (attempt >= BUSY_RETRY_ATTEMPTS || !isBusyError(err) || !keepTrying()) throw err;
      await sleep(BUSY_RETRY_DELAY_MS);
      // a Stop or New chat during the back-off
      if (!keepTrying()) throw err;
    }
  }
}

/** How long a Stop may wait for the server to end the turn before the
 * stream and the stop POST are aborted: the server's own bound once the
 * pump hears the stop (claude_engine.py `INTERRUPT_TIMEOUT_S` +
 * `DRAIN_TIMEOUT_S`) plus a second. A stop that lands while the prompt is
 * still being written waits on a `query()` with no bound of its own, so
 * there this is the only bound. */
export const STOP_ACK_TIMEOUT_MS = 16_000;

function streamFailure(err: unknown): StreamFailure {
  if (isAbortError(err)) return { kind: "aborted" };
  if (err instanceof ApiError && err.status === 404) {
    return { kind: "notFound", message: friendlyMessage(err) };
  }
  return { kind: "failed", message: friendlyMessage(err) };
}

/** The requests the driver makes; the hook passes the client module's. */
export type ChatClient = {
  createConversation: typeof createConversation;
  streamMessage: typeof streamMessage;
  stopTurn: typeof stopTurn;
  deleteConversation: typeof deleteConversation;
  confirmTool: typeof confirmTool;
};

export type ChatDriver = {
  dispatch(event: ChatEvent): Promise<void>;
  turnEnded(turn: TurnId): Promise<void>;
  current(): ChatState;
};

/** Runs the machine: each event goes through `step`, the new state is
 * published, and its effects start requests whose results come back as
 * events. Effects run after the state is stored, because a stream can call
 * back into dispatch before the request that started it returns. */
export function createChatDriver(publish: (state: ChatState) => void,
                                 client: ChatClient): ChatDriver {
  let state = initialChat();
  // the request each turn has in flight: its abort handle (streams only), a
  // promise that settles, never rejecting, once its result is dispatched,
  // and one that resolves once a stream's response has opened
  const requests = new Map<TurnId, { controller: AbortController | null;
                                     settled: Promise<void>;
                                     opened: Promise<void> }>();
  const turnEnds = new Map<TurnId, () => void>();

  /** Settles once the effects this event started have: for an answer, its
   * POST; for New chat, the old conversation's DELETE. */
  function dispatch(event: ChatEvent): Promise<void> {
    const out = step(state, event);
    state = out.state;
    publish(state);
    for (const [turn, resolve] of turnEnds) {
      if (!turnBusy(state, turn)) {
        turnEnds.delete(turn);
        resolve();
      }
    }
    return Promise.all(out.effects.map(run)).then(() => {});
  }

  function track(turn: TurnId, controller: AbortController | null,
                 start: () => Promise<void>,
                 opened: Promise<void> = new Promise(() => {})): Promise<void> {
    const entry = { controller, settled: Promise.resolve(), opened };
    requests.set(turn, entry);
    entry.settled = start().finally(() => {
      if (requests.get(turn) === entry) requests.delete(turn);
    });
    return entry.settled;
  }

  function run(effect: ChatEffect): Promise<void> {
    switch (effect.kind) {
      case "create": {
        const { turn } = effect;
        return track(turn, null, () => client.createConversation(effect.model).then(
          (c) => { void dispatch({ type: "created", turn, id: c.id, model: c.model }); },
          (err: unknown) => {
            void dispatch({ type: "createFailed", turn, message: friendlyMessage(err) });
          },
        ));
      }
      case "stream": {
        const { turn } = effect;
        const controller = new AbortController();
        let markOpened!: () => void;
        const opened = new Promise<void>((resolve) => { markOpened = resolve; });
        return track(turn, controller, () => streamWithBusyRetry(
          client.streamMessage, effect.conversation, effect.text,
          (ev) => { void dispatch({ type: "streamEvent", turn, event: ev, at: Date.now() }); },
          controller.signal, markOpened,
          () => state.turn.phase === "streaming" && state.turn.id === turn,
        ).then(
          () => { void dispatch({ type: "streamEnded", turn }); },
          (err: unknown) => {
            void dispatch({ type: "streamFailed", turn, failure: streamFailure(err) });
          },
        ), opened);
      }
      case "abort":
        requests.get(effect.turn)?.controller?.abort();
        return Promise.resolve();
      case "postStop": {
        // The stop is posted only once the stream's response has opened, so
        // the server has reserved this turn and the stop cannot reach
        // another; a stream that settles first was never this turn's. The
        // turn stays stopping until its stream has ended and this POST has
        // settled. If the POST fails, or the two are not done in time, the
        // stream and the POST are aborted: the dropped connection stops the
        // turn server-side.
        const { turn, conversation } = effect;
        const request = requests.get(turn);
        const streamDone = request?.settled ?? Promise.resolve();
        const post = new AbortController();
        const abort = () => {
          post.abort();
          if (requests.get(turn) === request) request?.controller?.abort();
        };
        const timer = setTimeout(abort, STOP_ACK_TIMEOUT_MS);
        const posted = (async () => {
          const open = await Promise.race([
            request?.opened.then(() => true) ?? Promise.resolve(false),
            streamDone.then(() => false),
          ]);
          if (!open) return;
          try {
            await client.stopTurn(conversation, post.signal);
          } catch {
            abort();
          }
        })().then(() => { void dispatch({ type: "stopSettled", turn }); });
        void Promise.all([streamDone, posted]).then(() => clearTimeout(timer));
        return posted;
      }
      case "delete": {
        const before = effect.after === null ? undefined : requests.get(effect.after)?.settled;
        return (async () => {
          await before;
          try {
            await client.deleteConversation(effect.conversation);
          } catch {
            // the server may have reaped it already; idle reaping cleans up
            // whatever this misses
          }
        })();
      }
      case "confirm": {
        const { turn, conversation, confirmId, allow } = effect;
        return client.confirmTool(conversation, confirmId, allow).then(
          () => {
            void dispatch({ type: "confirmPosted", turn, conversation, confirmId, allow,
                            at: Date.now() });
          },
          (err: unknown) => {
            void dispatch({ type: "confirmFailed", turn, confirmId,
                            notFound: err instanceof ApiError && err.status === 404,
                            message: friendlyMessage(err) });
          },
        );
      }
    }
  }

  /** Settles once the turn is no longer busy. */
  function turnEnded(turn: TurnId): Promise<void> {
    if (!turnBusy(state, turn)) return Promise.resolve();
    return new Promise((resolve) => turnEnds.set(turn, resolve));
  }

  return { dispatch, turnEnded, current: () => state };
}
