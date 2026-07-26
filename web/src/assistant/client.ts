// pattern: Imperative Shell
// HTTP client for /api/assistant/*. streamMessage bypasses apiFetch because
// apiFetch consumes res.json(); it replicates apiFetch's 401 handling.

import { ApiError, apiFetch, callUnauthorizedHandler } from "../api/client";
import { createSseParser, type AssistantEvent } from "./sse";

export async function createConversation(
  model: string | null,
): Promise<{ id: string; model: string }> {
  return apiFetch("/api/assistant/conversations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(model ? { model } : {}),
  });
}

export async function deleteConversation(id: string): Promise<void> {
  await apiFetch(`/api/assistant/conversations/${id}`, { method: "DELETE" });
}

export async function confirmTool(
  id: string,
  toolUseId: string,
  allow: boolean,
): Promise<void> {
  await apiFetch(`/api/assistant/conversations/${id}/confirm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tool_use_id: toolUseId, allow }),
  });
}

export async function streamMessage(
  id: string,
  text: string,
  onEvent: (ev: AssistantEvent) => void,
): Promise<void> {
  const path = `/api/assistant/conversations/${id}/messages`;
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (res.status === 401) {
    callUnauthorizedHandler();
    throw new ApiError(401, path);
  }
  if (!res.ok || !res.body) throw new ApiError(res.status, path);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const parser = createSseParser();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const ev of parser.push(decoder.decode(value, { stream: true }))) onEvent(ev);
  }
  for (const ev of parser.push(decoder.decode())) onEvent(ev);
}
