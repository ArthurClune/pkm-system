// Helpers for asserting on the server's own copy of a page. Used instead of
// a client-side "no .ws-banner" check before a reload: the offline banner
// only renders once syncingAfterReconnect is set (i.e. after an actual
// disconnect) — see OfflineIndicator.tsx. In a normally connected session
// pending>0 shows no banner at all, so waiting on the banner is vacuous and
// a reload can race the last queued mutation's HTTP delivery. Polling the
// server directly is deterministic. (pkm-h7jb, originally hit in pkm-7q14.)
import { expect, type Page } from "@playwright/test";

type BlockNode = { text: string; children: BlockNode[] };

function flattenText(blocks: BlockNode[]): string[] {
  return blocks.flatMap((b) => [b.text, ...flattenText(b.children)]);
}

/** Polls the server's copy of `pageTitle` until some block contains `text`
 * verbatim. Deliveries are ordered (single offline queue), so waiting for
 * the last edit implies every earlier one has landed too. */
export async function waitForServerText(page: Page, pageTitle: string, text: string) {
  await expect.poll(async () => {
    const res = await page.request.get(`/api/page/${encodeURIComponent(pageTitle)}`);
    if (!res.ok()) return [];
    const body = await res.json() as { blocks: BlockNode[] };
    return flattenText(body.blocks);
  }, { timeout: 20_000 }).toContain(text);
}
