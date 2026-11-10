// pattern: Imperative Shell
// Runs the assistant panel's chat machine (chatMachine.ts): dispatches the
// user's actions and each request's results into it, and starts the requests
// its effects name.

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "../api/client";
import type { ConversationId } from "../api/brands";
import {
  closeConversationBeacon,
  confirmTool,
  createConversation,
  deleteConversation,
  fetchModels,
  stopTurn,
  streamMessage,
  type AssistantModel,
} from "./client";
import {
  chatStatus,
  initialChat,
  modelLocked,
  shownModel,
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
  id: ConversationId,
  text: string,
  onEvent: (ev: AssistantEvent) => void,
  signal: AbortSignal,
  onOpen: () => void,
  keepTrying: () => boolean,
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await streamMessage(id, text, onEvent, signal, onOpen);
      return;
    } catch (err) {
      if (attempt >= BUSY_RETRY_ATTEMPTS || !isBusyError(err) || !keepTrying()) throw err;
      await sleep(BUSY_RETRY_DELAY_MS);
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

export type { ChatItem, PendingConfirm, PhaseInfo } from "./chatMachine";

function streamFailure(err: unknown): StreamFailure {
  if (isAbortError(err)) return { kind: "aborted" };
  if (err instanceof ApiError && err.status === 404) {
    return { kind: "notFound", message: friendlyMessage(err) };
  }
  return { kind: "failed", message: friendlyMessage(err) };
}

/** Runs the machine: each event goes through `step`, the new state is
 * published, and its effects start requests whose results come back as
 * events. Effects run after the state is stored, because a stream can call
 * back into dispatch before the request that started it returns. */
function createChatDriver(publish: (state: ChatState) => void) {
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
        return track(turn, null, () => createConversation(effect.model).then(
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
          effect.conversation, effect.text,
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
            await stopTurn(conversation, post.signal);
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
            await deleteConversation(effect.conversation);
          } catch {
            // the server may have reaped it already; idle reaping cleans up
            // whatever this misses
          }
        })();
      }
      case "confirm": {
        const { turn, conversation, confirmId, allow } = effect;
        return confirmTool(conversation, confirmId, allow).then(
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

export function useAssistant() {
  const [chat, setChat] = useState<ChatState>(initialChat);
  const [driver] = useState(() => createChatDriver(setChat));
  const modelsRequested = useRef(false);
  const pendingConfirm = chat.confirms[0] ?? null;

  // A page reload orphans the conversation id client-side
  // without deleting it server-side. Idle reaping and oldest-idle eviction
  // (server-side) eventually clean it up, but a best-effort beacon on
  // pagehide closes it immediately when the tab actually navigates away.
  useEffect(() => {
    const onPageHide = () => {
      const conversation = driver.current().conversation;
      if (conversation.kind === "open") closeConversationBeacon(conversation.id);
    };
    window.addEventListener("pagehide", onPageHide);
    return () => window.removeEventListener("pagehide", onPageHide);
  }, [driver]);

  // Called by the panel when it opens (not at app load: the panel component
  // is always mounted, and most loads never open it). One fetch per success;
  // a failure re-arms so the next open retries instead of pinning the
  // fallback models for the tab's lifetime.
  const ensureModels = useCallback(() => {
    if (modelsRequested.current) return;
    modelsRequested.current = true;
    fetchModels().then(
      (r) => {
        void driver.dispatch({
          type: "modelsLoaded",
          models: Array.isArray(r?.models) ? r.models : null,
          default: typeof r?.default === "string" ? r.default : null,
        });
      },
      () => {
        // keep the fallback models; a failed fetch must not break the panel
        modelsRequested.current = false;
      },
    );
  }, [driver]);

  // `m` comes from the <select> this feeds (AssistantPanel), whose options
  // are always rendered from `models` -- never free text.
  const setModel = useCallback((m: string) => {
    void driver.dispatch({ type: "pickModel", model: m as AssistantModel });
  }, [driver]);

  const send = useCallback(async (text: string) => {
    const before = driver.current().lastTurn;
    void driver.dispatch({ type: "send", text, at: Date.now() });
    const turn = driver.current().lastTurn;
    if (turn !== before) await driver.turnEnded(turn);
  }, [driver]);

  const stop = useCallback(() => {
    void driver.dispatch({ type: "stop", at: Date.now() });
  }, [driver]);

  // answers the head this render showed, which is what the user answered
  const respondConfirm = useCallback(async (allow: boolean) => {
    if (pendingConfirm === null) return;
    await driver.dispatch({ type: "answer", confirmId: pendingConfirm.confirmId, allow });
  }, [driver, pendingConfirm]);

  // The chat clears on the click; the promise settles once the old
  // conversation's DELETE has, which waits for its aborted stream.
  const newChat = useCallback(async () => {
    await driver.dispatch({ type: "newChat" });
  }, [driver]);

  return {
    items: chat.items,
    status: chatStatus(chat),
    phase: chat.phase,
    error: chat.error,
    model: shownModel(chat),
    setModel,
    models: chat.models,
    ensureModels,
    modelLocked: modelLocked(chat),
    pendingConfirm,
    pendingConfirmCount: chat.confirms.length,
    answering: chat.answering,
    send,
    stop,
    respondConfirm,
    newChat,
  };
}
