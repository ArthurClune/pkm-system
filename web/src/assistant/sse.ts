// pattern: Functional Core
// Incremental parser for the assistant's SSE stream (event:/data: frames).

export type AssistantEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_started"; name: string; summary: string }
  | { type: "tool_finished"; name: string }
  | { type: "phase"; label: string }
  | { type: "confirm_request"; tool_use_id: string; ops_preview: string }
  | { type: "turn_done"; usage: Record<string, unknown> | null }
  | { type: "error"; message: string };

const EVENT_TYPES = new Set([
  "text_delta",
  "tool_started",
  "tool_finished",
  "phase",
  "confirm_request",
  "turn_done",
  "error",
]);

function parseFrame(frame: string): AssistantEvent | null {
  let eventName = "";
  let data = "";
  for (const line of frame.split("\n")) {
    if (line.startsWith("event: ")) eventName = line.slice("event: ".length);
    else if (line.startsWith("data: ")) data = line.slice("data: ".length);
  }
  if (!EVENT_TYPES.has(eventName) || !data) return null;
  try {
    const payload = JSON.parse(data) as Record<string, unknown>;
    return { ...payload, type: eventName } as AssistantEvent;
  } catch {
    return null;
  }
}

export function createSseParser(): { push(chunk: string): AssistantEvent[] } {
  let buffer = "";
  return {
    push(chunk: string): AssistantEvent[] {
      buffer += chunk;
      const events: AssistantEvent[] = [];
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const parsed = parseFrame(frame);
        if (parsed) events.push(parsed);
      }
      return events;
    },
  };
}
