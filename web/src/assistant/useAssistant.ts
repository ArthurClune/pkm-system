// pattern: Imperative Shell
// Chat state for the assistant panel: lazy conversation, SSE-driven items.

import { useCallback, useRef, useState } from "react";
import { confirmTool, createConversation, deleteConversation, streamMessage } from "./client";
import type { AssistantEvent } from "./sse";

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
        setItems((prev) =>
          prev.map((item) =>
            item.kind === "tool" && item.name === ev.name && !item.done
              ? { ...item, done: true }
              : item,
          ),
        );
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

  const send = useCallback(
    async (text: string) => {
      if (!text.trim()) return;
      setError(null);
      setStatus("busy");
      setItems((prev) => [...prev, { kind: "user", text }]);
      try {
        if (conversationId.current === null) {
          const created = await createConversation(model);
          conversationId.current = created.id;
        }
        setModelLocked(true);
        await streamMessage(conversationId.current, text, applyEvent);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setPendingConfirm(null);
        setStatus("idle");
      }
    },
    [applyEvent, model],
  );

  const respondConfirm = useCallback(
    async (allow: boolean) => {
      const id = conversationId.current;
      const pending = pendingConfirm;
      if (id === null || pending === null) return;
      setPendingConfirm(null);
      setStatus("busy");
      await confirmTool(id, pending.toolUseId, allow);
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
    respondConfirm,
    newChat,
  };
}
