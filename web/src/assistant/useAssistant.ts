// pattern: Imperative Shell
// The assistant panel's hook: holds the chat machine's state for React,
// builds the driver that runs it (chatDriver.ts), and turns the panel's
// clicks into its events.

import { useCallback, useEffect, useRef, useState } from "react";
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
import { createChatDriver } from "./chatDriver";
import { canStop, chatStatus, initialChat, modelLocked, shownModel, type ChatState } from "./chatMachine";

export { STOP_ACK_TIMEOUT_MS } from "./chatDriver";
export type { ChatItem, PendingConfirm, PhaseInfo } from "./chatMachine";

export function useAssistant() {
  const [chat, setChat] = useState<ChatState>(initialChat);
  const [driver] = useState(() => createChatDriver(setChat, {
    createConversation, streamMessage, stopTurn, deleteConversation, confirmTool,
  }));
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
    canStop: canStop(chat),
    send,
    stop,
    respondConfirm,
    newChat,
  };
}
