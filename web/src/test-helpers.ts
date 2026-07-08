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
  return { uid, text, heading: null, collapsed: false,
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
