// Extends Playwright's `test` so the visible assertions in a spec are not
// the only thing that can fail it: any HTTP 5xx from the app (server bug,
// unhandled exception) fails the test too, even if the page happened to
// recover and every on-screen assertion still passed. See
// docs/2026-07-10-implementation-review.md finding 1 - the original
// "database is locked" 500s were invisible to `pnpm e2e` because nothing
// checked response status.
import { test as base, expect, type BrowserContext } from "@playwright/test";

function describeResponse(status: number, method: string, url: string): string {
  return `${status} ${method} ${url}`;
}

/** Record any 5xx response seen on `context` into `badResponses`. The
 * default `context`/`page` fixtures below call this automatically; specs
 * that create additional contexts directly (e.g. to simulate a second
 * browser/client) must call it themselves on each one. */
export function trackResponses(context: BrowserContext, badResponses: string[]): void {
  context.on("response", (response) => {
    if (response.status() >= 500) {
      badResponses.push(
        describeResponse(response.status(), response.request().method(), response.url()));
    }
  });
}

export const test = base.extend<{ badResponses: string[] }>({
  badResponses: async ({}, use) => {
    await use([]);
  },

  context: async ({ context, badResponses }, use) => {
    trackResponses(context, badResponses);
    await use(context);
  },
});

test.afterEach(async ({ badResponses }) => {
  if (badResponses.length > 0) {
    throw new Error(`Server returned HTTP 5xx during test:\n${badResponses.join("\n")}`);
  }
});

export { expect };
