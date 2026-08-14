// pattern: Imperative Shell
// Chat state for the assistant panel: lazy conversation, SSE-driven items.

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "../api/client";
import {
  closeConversationBeacon,
  confirmTool,
  createConversation,
  deleteConversation,
  fetchModels,
  streamMessage,
} from "./client";
import type { AssistantEvent } from "./sse";

/** ApiError carries the server's `detail` message (pkm-c98s item 5); prefer
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

// pkm-c98s item 3: AbortController.abort() rejects the client's own fetch
// promise the instant Stop is clicked, well before the server has noticed
// the dropped connection and released the conversation's busy flag (see
// service.py's synchronous reservation, item 7). Sending again right after
// Stop can therefore land on the server a few milliseconds too early and
// see a 409. Retrying briefly closes that window without changing the
// contract for a *sustained* busy conflict, which still surfaces as an
// error once these short retries are exhausted.
const BUSY_RETRY_ATTEMPTS = 5;
const BUSY_RETRY_DELAY_MS = 60;

async function streamWithBusyRetry(
  id: string,
  text: string,
  onEvent: (ev: AssistantEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await streamMessage(id, text, onEvent, signal);
      return;
    } catch (err) {
      if (attempt >= BUSY_RETRY_ATTEMPTS || !isBusyError(err)) throw err;
      await sleep(BUSY_RETRY_DELAY_MS);
    }
  }
}

export type ChatItem =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool"; name: string; summary: string; done: boolean };

export type PendingConfirm = { toolUseId: string; opsPreview: string };

export function useAssistant() {
  const [items, setItems] = useState<ChatItem[]>([]);
  const [status, setStatus] = useState<"idle" | "busy" | "confirm">("idle");
  const [error, setError] = useState<string | null>(null);
  const [model, setModelState] = useState("sonnet");
  // The claude trio is always servable, so it doubles as the offline/failed
  // fallback; the server list adds glm only when a z.ai key is configured.
  const [models, setModels] = useState(["sonnet", "opus", "haiku"]);
  const [modelLocked, setModelLocked] = useState(false);
  // distinguishes the user's own picker choice from the initial state, so
  // the fetched server default can fill the latter without clobbering the
  // former
  const modelTouched = useRef(false);
  const setModel = useCallback((m: string) => {
    modelTouched.current = true;
    setModelState(m);
  }, []);
  const modelsRequested = useRef(false);
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm | null>(null);
  const conversationId = useRef<string | null>(null);
  const abortController = useRef<AbortController | null>(null);
  const stopRequested = useRef(false);

  // Turn generations (pkm-6ts2). send() takes the next generation; newChat()
  // bumps it to supersede whatever is running. Every state write that happens
  // after an await is gated on still being the current generation, so a
  // superseded turn's events and finalizers cannot touch the chat that
  // replaced it.
  const turnGen = useRef(0);
  const activeTurn = useRef<Promise<void> | null>(null);

  // pkm-c98s item 1: a page reload orphans the conversation id client-side
  // without deleting it server-side. Idle reaping and oldest-idle eviction
  // (server-side) eventually clean it up, but a best-effort beacon on
  // pagehide closes it immediately when the tab actually navigates away.
  useEffect(() => {
    const onPageHide = () => {
      const id = conversationId.current;
      if (id !== null) closeConversationBeacon(id);
    };
    window.addEventListener("pagehide", onPageHide);
    return () => window.removeEventListener("pagehide", onPageHide);
  }, []);

  // Called by the panel when it opens (not at app load: the panel component
  // is always mounted, and most loads never open it). One fetch per success;
  // a failure re-arms so the next open retries instead of pinning the
  // fallback trio for the tab's lifetime.
  const ensureModels = useCallback(() => {
    if (modelsRequested.current) return;
    modelsRequested.current = true;
    fetchModels()
      .then((r) => {
        if (Array.isArray(r?.models) && r.models.length > 0) setModels(r.models);
        if (typeof r?.default === "string" && !modelTouched.current
            && conversationId.current === null) {
          setModelState(r.default);
        }
      })
      .catch(() => {
        // keep the fallback trio; a failed fetch must not break the panel
        modelsRequested.current = false;
      });
  }, []);

  const applyEvent = useCallback((ev: AssistantEvent) => {
    switch (ev.type) {
      case "text_delta":
        setItems((prev) => {
          const last = prev[prev.length - 1];
          if (last && last.kind === "assistant") {
            return [...prev.slice(0, -1), { kind: "assistant", text: last.text + ev.text }];
          }
          return [...prev, { kind: "assistant", text: ev.text }];
        });
        break;
      case "tool_started":
        setItems((prev) => [...prev, { kind: "tool", name: ev.name, summary: ev.summary, done: false }]);
        break;
      case "tool_finished":
        setItems((prev) => {
          const idx = prev.findIndex(
            (item) => item.kind === "tool" && item.name === ev.name && !item.done,
          );
          if (idx === -1) return prev;
          const item = prev[idx];
          if (item.kind !== "tool") return prev;
          return [...prev.slice(0, idx), { ...item, done: true }, ...prev.slice(idx + 1)];
        });
        break;
      case "confirm_request":
        setPendingConfirm({ toolUseId: ev.tool_use_id, opsPreview: ev.ops_preview });
        setStatus("confirm");
        break;
      case "turn_done":
        break;
      case "error":
        setError(ev.message);
        break;
    }
  }, []);

  // Runs one turn; on a 404 (server reaped the conversation -- idle timeout
  // or oldest-idle eviction elsewhere, pkm-c98s item 4) it resets the
  // conversation id and retries exactly once with a freshly created one,
  // instead of leaving the panel stuck talking to a dead id.
  const runTurn = useCallback(
    async (text: string, allowRetry: boolean, gen: number): Promise<void> => {
      if (gen !== turnGen.current) return;
      if (conversationId.current === null) {
        const created = await createConversation(model);
        if (gen !== turnGen.current) {
          // newChat landed while the conversation was being created: adopting
          // the id here would make the "new" chat continue the old one, so
          // close it instead of leaking it until the server reaps it.
          try {
            await deleteConversation(created.id);
          } catch {
            // best effort; idle reaping cleans it up either way
          }
          return;
        }
        conversationId.current = created.id;
      }
      setModelLocked(true);
      const controller = new AbortController();
      abortController.current = controller;
      try {
        await streamWithBusyRetry(conversationId.current, text, (ev) => {
          // a superseded turn keeps streaming until its abort lands; its
          // events must never fold into the new transcript
          if (gen !== turnGen.current) return;
          applyEvent(ev);
        }, controller.signal);
      } catch (err) {
        if (allowRetry && err instanceof ApiError && err.status === 404
            && gen === turnGen.current) {
          conversationId.current = null;
          await runTurn(text, false, gen);
          return;
        }
        throw err;
      } finally {
        // identity check: a newer turn's controller must survive this cleanup,
        // or stop() would silently abort nothing
        if (abortController.current === controller) abortController.current = null;
      }
    },
    [applyEvent, model],
  );

  const send = useCallback(
    async (text: string) => {
      if (!text.trim()) return;
      turnGen.current += 1;
      const gen = turnGen.current;
      const current = () => gen === turnGen.current;
      setError(null);
      setStatus("busy");
      setItems((prev) => [...prev, { kind: "user", text }]);
      stopRequested.current = false;
      const run = (async () => {
        try {
          await runTurn(text, true, gen);
        } catch (err) {
          // pkm-c98s item 3: a user-requested Stop aborts the fetch, which
          // rejects with an AbortError -- that is success, not a failure to
          // report. A superseded turn's failure (pkm-6ts2) belongs to a chat
          // that no longer exists, so it is not reported either.
          if (current() && !(stopRequested.current && isAbortError(err))) {
            setError(friendlyMessage(err));
          }
        } finally {
          if (current()) {
            setPendingConfirm(null);
            setStatus("idle");
          }
        }
      })();
      activeTurn.current = run;
      try {
        await run;
      } finally {
        if (activeTurn.current === run) activeTurn.current = null;
      }
    },
    [runTurn],
  );

  const stop = useCallback(() => {
    stopRequested.current = true;
    abortController.current?.abort();
  }, []);

  const respondConfirm = useCallback(
    async (allow: boolean) => {
      const gen = turnGen.current;
      const id = conversationId.current;
      const pending = pendingConfirm;
      if (id === null || pending === null) return;
      setPendingConfirm(null);
      setStatus("busy");
      try {
        await confirmTool(id, pending.toolUseId, allow);
      } catch (err) {
        // newChat superseded this decision: the conversation it belonged to is
        // gone, and neither the reset below nor an error banner may land on the
        // chat that replaced it (pkm-6ts2).
        if (gen !== turnGen.current) return;
        if (err instanceof ApiError && err.status === 404) {
          // reaped while waiting on the user's decision: no live turn to
          // resume, so start clean rather than resurrect a dead card
          conversationId.current = null;
          setStatus("idle");
          setError("This chat expired before you responded; send a new message to start a fresh one.");
          return;
        }
        setPendingConfirm(pending);
        setStatus("confirm");
        setError(friendlyMessage(err));
      }
    },
    [pendingConfirm],
  );

  const newChat = useCallback(async () => {
    // Supersede first: from here on the running turn's events and finalizers
    // are ignored, which is what makes clearing the state below safe to do
    // immediately rather than after the abort round-trip (pkm-6ts2).
    turnGen.current += 1;
    const id = conversationId.current;
    const inflight = activeTurn.current;
    const controller = abortController.current;
    conversationId.current = null;
    abortController.current = null;
    activeTurn.current = null;
    setItems([]);
    setError(null);
    setStatus("idle");
    setPendingConfirm(null);
    setModelLocked(false);
    controller?.abort();
    // Await the aborted turn so the server has observed the dropped connection
    // (and that turn's finalizers have all run) before the DELETE. Only when a
    // stream actually existed: a turn still inside createConversation has no
    // connection to drop and no abort signal to cut it short, so waiting on it
    // could hang for as long as that request does -- and it closes the
    // conversation it created itself, via the generation check in runTurn.
    // (`controller` truthy doesn't guarantee a *live* stream: mid-404-retry,
    // runTurn can be back inside an unabortable createConversation with
    // controller still set from the attempt that just failed. That's benign
    // here -- `id` is null in that window too, so this function's own DELETE
    // below is skipped either way, and the retry's own generation check
    // closes whatever it creates.)
    // send()'s own try/catch/finally guarantees `inflight` always fulfils, so
    // no `.catch()` is needed here to keep this await from rejecting.
    if (controller && inflight) await inflight;
    if (id !== null) {
      try {
        await deleteConversation(id);
      } catch {
        // server may have reaped it already; a fresh chat is the goal
      }
    }
  }, []);

  return {
    items,
    status,
    error,
    model,
    setModel,
    models,
    ensureModels,
    modelLocked,
    pendingConfirm,
    send,
    stop,
    respondConfirm,
    newChat,
  };
}
