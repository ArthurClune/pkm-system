// pattern: Imperative Shell
// Chat state for the assistant panel: lazy conversation, SSE-driven items.

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "../api/client";
import {
  closeConversationBeacon,
  confirmTool,
  createConversation,
  deleteConversation,
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
  const [model, setModel] = useState("sonnet");
  const [modelLocked, setModelLocked] = useState(false);
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm | null>(null);
  const conversationId = useRef<string | null>(null);
  const abortController = useRef<AbortController | null>(null);
  const stopRequested = useRef(false);

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
    async (text: string, allowRetry: boolean): Promise<void> => {
      if (conversationId.current === null) {
        const created = await createConversation(model);
        conversationId.current = created.id;
      }
      setModelLocked(true);
      const controller = new AbortController();
      abortController.current = controller;
      try {
        await streamWithBusyRetry(conversationId.current, text, applyEvent, controller.signal);
      } catch (err) {
        if (allowRetry && err instanceof ApiError && err.status === 404) {
          conversationId.current = null;
          await runTurn(text, false);
          return;
        }
        throw err;
      } finally {
        abortController.current = null;
      }
    },
    [applyEvent, model],
  );

  const send = useCallback(
    async (text: string) => {
      if (!text.trim()) return;
      setError(null);
      setStatus("busy");
      setItems((prev) => [...prev, { kind: "user", text }]);
      stopRequested.current = false;
      try {
        await runTurn(text, true);
      } catch (err) {
        // pkm-c98s item 3: a user-requested Stop aborts the fetch, which
        // rejects with an AbortError -- that is success, not a failure to
        // report.
        if (!(stopRequested.current && isAbortError(err))) {
          setError(friendlyMessage(err));
        }
      } finally {
        setPendingConfirm(null);
        setStatus("idle");
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
      const id = conversationId.current;
      const pending = pendingConfirm;
      if (id === null || pending === null) return;
      setPendingConfirm(null);
      setStatus("busy");
      try {
        await confirmTool(id, pending.toolUseId, allow);
      } catch (err) {
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
    const id = conversationId.current;
    conversationId.current = null;
    setItems([]);
    setError(null);
    setStatus("idle");
    setPendingConfirm(null);
    setModelLocked(false);
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
    modelLocked,
    pendingConfirm,
    send,
    stop,
    respondConfirm,
    newChat,
  };
}
