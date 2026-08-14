// pattern: Imperative Shell
// HTTP client for /api/assistant/*. streamMessage bypasses apiFetch because
// apiFetch consumes res.json(); it replicates apiFetch's 401 handling.

import { ApiError, callUnauthorizedHandler, readErrorDetail } from "../api/client";
import { apiDelete, apiGet, apiPost } from "../api/typedClient";
import type { components } from "../api/types";
import { createSseParser, type AssistantEvent } from "./sse";

/** Models the server offers the picker; glm appears only when the server
 * has a z.ai key configured. */
export function fetchModels(): Promise<components["schemas"]["AssistantModels"]> {
  return apiGet("/api/assistant/models", {});
}

export function createConversation(
  model: string | null,
): Promise<components["schemas"]["AssistantConversation"]> {
  return apiPost("/api/assistant/conversations",
                 { body: model ? { model } : {} });
}

export async function deleteConversation(id: string): Promise<void> {
  await apiDelete("/api/assistant/conversations/{conversation_id}",
                  { path: { conversation_id: id } });
}

/** Best-effort, fire-and-forget close for pagehide (pkm-c98s item 1):
 * `fetch` calls started from a `pagehide` handler are routinely dropped by
 * the browser before they reach the network, but `navigator.sendBeacon`
 * survives page teardown. Beacons can only POST with no custom
 * headers/body, so this hits the same route the DELETE above uses, just
 * over its POST alias (see server routes.py). There is no response to
 * check -- if it doesn't land, the conversation is still cleaned up later
 * by idle reaping or oldest-idle eviction. */
export function closeConversationBeacon(id: string): void {
  if (typeof navigator === "undefined" || typeof navigator.sendBeacon !== "function") return;
  navigator.sendBeacon(`/api/assistant/conversations/${id}`);
}

export async function confirmTool(
  id: string,
  toolUseId: string,
  allow: boolean,
): Promise<void> {
  await apiPost("/api/assistant/conversations/{conversation_id}/confirm", {
    path: { conversation_id: id },
    body: { tool_use_id: toolUseId, allow },
  });
}

export async function streamMessage(
  id: string,
  text: string,
  onEvent: (ev: AssistantEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const path = `/api/assistant/conversations/${id}/messages`;
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
    signal,
  });
  if (res.status === 401) {
    callUnauthorizedHandler();
    throw new ApiError(401, path, await readErrorDetail(res));
  }
  if (!res.ok || !res.body) throw new ApiError(res.status, path, res.ok ? undefined : await readErrorDetail(res));
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
