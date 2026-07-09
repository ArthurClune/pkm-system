import { vi } from "vitest";
import type { BlockNode, PagePayload } from "./api/payloads";

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Stub global fetch; handlers are [urlPrefix, body] pairs, FIRST match
 * wins — list more-specific prefixes first. Unmatched urls 404. */
export function stubFetch(handlers: [string, unknown][]) {
  const mock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    for (const [prefix, body] of handlers) {
      if (url.startsWith(prefix)) return jsonResponse(body);
    }
    return jsonResponse({ detail: "not found" }, 404);
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

export function block(uid: string, text: string,
                      over: Partial<BlockNode> = {}): BlockNode {
  return { uid, text, heading: null, collapsed: false, order_idx: 0,
           created_at: 1000, updated_at: 2000, children: [], ...over };
}

export function pagePayload(title: string, blocks: BlockNode[],
                            over: Partial<PagePayload> = {}): PagePayload {
  return {
    page: { id: 1, title, created_at: 1000, updated_at: 2000 },
    blocks,
    backlinks: { groups: [], total_pages: 0, offset: 0, limit: 20 },
    block_ref_texts: {},
    ...over,
  };
}

/** WebSocket stub installed globally in test-setup: quiet by default (never
 * opens); tests drive instances via FakeWebSocket.instances. */
export class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  url: string;
  sent: string[] = [];
  closedByApp = false;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(data: string) { this.sent.push(data); }

  close() { this.closedByApp = true; this.onclose?.(); }

  // --- test drivers ---
  open() { this.onopen?.(); }
  message(body: unknown) { this.onmessage?.({ data: JSON.stringify(body) }); }
  drop() { this.onclose?.(); }
}
