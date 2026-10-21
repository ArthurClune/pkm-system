// Every surface that keys an outline session by title keys it by the page's
// canonical title, whatever spelling it was opened with: the page view, a
// sidebar panel, and the page-load controller they share. Two sessions for
// one page cannot see each other's remote batches.
//
// A variant is what the server folds onto the title: control whitespace
// widened into its plain-space gaps and padding its edges, and plain-space
// padding too while the plain-space flag is on. The stub server folds a
// requested title with the replica's canonicalizeTitle, which
// shared/fixtures/title_parity.json pins to the server's.
import { cleanup, render, renderHook, type RenderResult, waitFor } from "@testing-library/react";
import fc from "fast-check";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, test, vi } from "vitest";
import { MainRoutes } from "../App";
import { EditableSidebarPanel } from "../components/EditableSidebarPanel";
import { pagePath } from "../paths";
import { canonicalizeTitle, titleSyntaxReason } from "../replica/titles";
import { ROUTER_FUTURE_FLAGS } from "../router";
import { SyncContext } from "../sync/SyncProvider";
import {
  block, canonicalTitleOf, jsonResponse, makeSync, pagePayload, rawTitleOf,
} from "../test-helpers";
import { isOutlineEditorActive, isOutlineSessionActive } from "./outlineSessions";
import { useOutlinePageLoad } from "./useOutlinePageLoad";

class NoopIntersectionObserver {
  root = null;
  rootMargin = "";
  thresholds: number[] = [];
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] { return []; }
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const CONTROL = ["\t", "\n", "\r", "\f", "\v"];
type Kind = "identity" | "control" | "padded" | "padded_control";

interface TitleCase { active: boolean; canonical: string; variant: string; kind: Kind }

// Words hold no whitespace and none of the refused ref syntax.
const word = fc.string({
  unit: fc.constantFrom(...[..."abcXYZ019éß✨😀%/?&+.-'():;,="]),
  minLength: 1, maxLength: 5,
});

// One plain space or NBSP between words, so canonicalisation has no edge
// or run of whitespace to remove. A title with a `.`, `..` or empty path
// segment has no URL and is refused; a quarter of the draws make one.
const unreachable = fc.constantFrom(
  (t: string) => `/${t}`, (t: string) => `${t}/`, (t: string) => `${t}//x`,
  (t: string) => `${t}/./x`, (t: string) => `${t}/../x`, () => ".", () => "..");
const canonicalTitle = fc
  .tuple(fc.array(word, { minLength: 1, maxLength: 4 }),
         fc.array(fc.constantFrom(" ", " ", " "), { minLength: 3, maxLength: 3 }),
         fc.integer({ min: 0, max: 3 }), unreachable)
  .map(([words, gaps, coin, spoil]) => {
    const text = words.reduce((acc, w, i) => acc + gaps[i - 1] + w);
    return coin === 0 ? spoil(text) : text;
  });

const run = fc.array(fc.constantFrom(" ", ...CONTROL), { minLength: 1, maxLength: 3 })
  .map((cs) => cs.join(""));
const edge = fc.array(fc.constantFrom(" ", ...CONTROL), { maxLength: 3 })
  .map((cs) => cs.join(""));

const controlVariant = (text: string) =>
  fc.tuple(edge, fc.array(run, { minLength: 8, maxLength: 8 }), edge,
           fc.constantFrom(...CONTROL))
    .map(([lead, runs, trail, fallback]) => {
      const out = lead + text.split(" ").reduce((acc, w, i) => acc + runs[i - 1] + w)
        + trail;
      return CONTROL.some((c) => out.includes(c)) ? out : out + fallback;
    });

const pad = fc.integer({ min: 0, max: 3 });

const refused = (c: TitleCase) => titleSyntaxReason(c.canonical) !== null;

// Plain-space padding folds only under the flag, so a padded kind draws it
// on; the others draw it either way.
const titleCase: fc.Arbitrary<TitleCase> = fc
  .tuple(fc.constantFrom<Kind>("identity", "control", "padded", "padded_control"),
         fc.boolean(), canonicalTitle)
  .chain(([kind, coin, canonical]) => {
    const active = kind === "padded" || kind === "padded_control" || coin;
    return ((): fc.Arbitrary<TitleCase> => {
      const of = (variant: fc.Arbitrary<string>) =>
        variant.map((v) => ({ active, canonical, variant: v, kind }));
      if (kind === "identity") return of(fc.constant(canonical));
      if (kind === "control") return of(controlVariant(canonical));
      if (kind === "padded") {
        return of(fc.tuple(pad, pad).map(([lead, trail]) =>
          " ".repeat(lead) + canonical + " ".repeat(Math.max(trail, 1 - lead))));
      }
      return of(fc.tuple(pad, controlVariant(canonical), pad).map(([lead, v, trail]) =>
        " ".repeat(lead) + v + " ".repeat(trail)));
    })();
  })
  // The generator's own check, not an oracle for the surfaces.
  .map((c) => {
    expect(canonicalizeTitle(c.variant, c.active)).toBe(c.canonical);
    return c;
  });

/** The server's page route: a spelling that folds onto `canonical` reads
 * that page, under its stored title; anything else is a 404, and so is
 * every read of a refused title, which no page can hold. */
function serve(c: TitleCase) {
  const { active, canonical } = c;
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    const prefix = "/api/page/";
    if (url.startsWith(prefix) && !refused(c)) {
      const path = url.slice(prefix.length).split("?")[0];
      const requested = path.split("/").map(decodeURIComponent).join("/");
      if (canonicalizeTitle(requested, active) === canonical) {
        return Promise.resolve(jsonResponse(pagePayload(
          canonicalTitleOf(canonical), [block("tuid-k1", "the page's block")])));
      }
    }
    return Promise.resolve(jsonResponse({ detail: "not found" }, 404));
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("IntersectionObserver", NoopIntersectionObserver);
  return fetchMock;
}

const settle = () => new Promise((r) => setTimeout(r, 20));

function tallied() {
  const tally: Record<Kind | "refused", number> = {
    identity: 0, control: 0, padded: 0, padded_control: 0, refused: 0,
  };
  const reach = () => {
    // Each kind of variant must actually be drawn, or the property is
    // vacuous. A kind, and a refused title, is a quarter of the draws:
    // over 40 runs, missing one by chance is about a one-in-100000 event.
    for (const n of Object.values(tally)) expect(n).toBeGreaterThan(0);
  };
  const count = (c: TitleCase) => {
    tally[c.kind] += 1;
    if (refused(c)) tally.refused += 1;
  };
  return { count, reach };
}

/** The rendered page's outline editor is the canonical title's, and no
 * session exists under the variant's spelling. A refused title reaches no
 * page and holds no editor; a sidebar panel shows its error, while a
 * /page/ URL with a dot segment is not that title's URL at all (the router
 * resolves it away), so the page view need only not open the title. */
async function expectKeyedByCanonical(view: RenderResult, c: TitleCase,
                                      showsError: boolean) {
  if (refused(c)) {
    if (showsError) {
      await waitFor(() => expect(view.container.querySelector(".error")).not.toBeNull());
    } else await settle();
    expect(isOutlineEditorActive(rawTitleOf(c.canonical))).toBe(false);
    expect(isOutlineEditorActive(rawTitleOf(c.variant))).toBe(false);
    return;
  }
  await view.findByText("the page's block");
  await settle();
  expect(isOutlineEditorActive(rawTitleOf(c.canonical))).toBe(true);
  if (c.variant !== c.canonical) {
    expect(isOutlineEditorActive(rawTitleOf(c.variant))).toBe(false);
    expect(isOutlineSessionActive(rawTitleOf(c.variant))).toBe(false);
  }
}

describe("a variant title keys the outline by the canonical title", () => {
  test("useOutlinePageLoad", async () => {
    const { count, reach } = tallied();
    await fc.assert(fc.asyncProperty(titleCase, async (c) => {
      count(c);
      const fetchMock = serve(c);
      const hook = renderHook(
        () => useOutlinePageLoad(rawTitleOf(c.variant), () => null));
      let mounted = true;
      try {
        if (refused(c)) {
          await waitFor(() => expect(hook.result.current.error).not.toBeNull());
          expect(hook.result.current.payload).toBeNull();
          return;
        }
        await waitFor(() => expect(hook.result.current.payload).not.toBeNull());
        await settle();
        expect(hook.result.current.payload?.page.title).toBe(c.canonical);
        expect(isOutlineSessionActive(rawTitleOf(c.canonical))).toBe(true);
        if (c.variant !== c.canonical) {
          expect(isOutlineSessionActive(rawTitleOf(c.variant))).toBe(false);
        }
        expect(fetchMock).toHaveBeenCalledTimes(c.variant === c.canonical ? 1 : 2);
        hook.unmount();
        mounted = false;
        expect(isOutlineSessionActive(rawTitleOf(c.canonical))).toBe(false);
      } finally {
        if (mounted) hook.unmount();
        vi.unstubAllGlobals();
      }
    }), { numRuns: 40 });
    reach();
  }, 30_000);

  test("EditableSidebarPanel", async () => {
    const { count, reach } = tallied();
    await fc.assert(fc.asyncProperty(titleCase, async (c) => {
      count(c);
      serve(c);
      const view = render(
        <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
          <SyncContext.Provider value={makeSync()}>
            <EditableSidebarPanel title={rawTitleOf(c.variant)} />
          </SyncContext.Provider>
        </MemoryRouter>);
      try {
        await expectKeyedByCanonical(view, c, true);
      } finally {
        view.unmount();
        vi.unstubAllGlobals();
      }
    }), { numRuns: 40 });
    reach();
  }, 30_000);

  test("the page view, opened at the variant's /page/ URL", async () => {
    const { count, reach } = tallied();
    await fc.assert(fc.asyncProperty(titleCase, async (c) => {
      count(c);
      serve(c);
      // The router warns as it collapses a refused title's `//`.
      const warn = refused(c)
        ? vi.spyOn(console, "warn").mockImplementation(() => {}) : null;
      const view = render(
        <MemoryRouter future={ROUTER_FUTURE_FLAGS}
                      initialEntries={[pagePath(rawTitleOf(c.variant))]}>
          <SyncContext.Provider value={makeSync()}>
            <MainRoutes />
          </SyncContext.Provider>
        </MemoryRouter>);
      try {
        await expectKeyedByCanonical(view, c, false);
        for (const [message] of warn?.mock.calls ?? []) {
          expect(String(message)).toContain("double slashes");
        }
      } finally {
        view.unmount();
        warn?.mockRestore();
        vi.unstubAllGlobals();
      }
    }), { numRuns: 40 });
    reach();
  }, 30_000);
});
