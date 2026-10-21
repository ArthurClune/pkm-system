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
import { canonicalizeTitle } from "../replica/titles";
import { ROUTER_FUTURE_FLAGS } from "../router";
import { SyncContext } from "../sync/SyncProvider";
import {
  block, canonicalTitleOf, jsonResponse, makeSync, pagePayload, rawTitleOf,
} from "../test-helpers";
import { isOutlineEditorActive, isOutlineSessionActive } from "./outlineSessions";
import { useOutlinePageLoad } from "./useOutlinePageLoad";

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
// or run of whitespace to remove. A `.`, `..` or empty path segment has
// no URL (a URL client drops the first two, the router's navigate
// collapses `//`), so it is spelled out of the draw.
const canonicalTitle = fc
  .tuple(fc.array(word, { minLength: 1, maxLength: 4 }),
         fc.array(fc.constantFrom(" ", " ", " "), { minLength: 3, maxLength: 3 }))
  .map(([words, gaps]) => {
    const text = words.reduce((acc, w, i) => acc + gaps[i - 1] + w);
    return text.split("/").some((seg) => seg === "" || seg === "." || seg === "..")
      ? text.replace(/\//g, "x") : text;
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
 * that page, under its stored title; anything else is a 404. */
function serve({ active, canonical }: TitleCase) {
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    const prefix = "/api/page/";
    if (url.startsWith(prefix)) {
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
  return fetchMock;
}

const settle = () => new Promise((r) => setTimeout(r, 20));

function tallied() {
  const tally: Record<Kind, number> = {
    identity: 0, control: 0, padded: 0, padded_control: 0,
  };
  const reach = () => {
    // Each kind of variant must actually be drawn, or the property is
    // vacuous. A kind is a quarter of the draws: over 40 runs, missing one
    // by chance is about a one-in-100000 event.
    for (const n of Object.values(tally)) expect(n).toBeGreaterThan(0);
  };
  return { tally, reach };
}

/** The rendered page's outline editor is the canonical title's, and no
 * session exists under the variant's spelling. */
async function expectKeyedByCanonical(view: RenderResult, c: TitleCase) {
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
    const { tally, reach } = tallied();
    await fc.assert(fc.asyncProperty(titleCase, async (c) => {
      const fetchMock = serve(c);
      const hook = renderHook(
        () => useOutlinePageLoad(rawTitleOf(c.variant), () => null));
      let mounted = true;
      try {
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
      tally[c.kind] += 1;
    }), { numRuns: 40 });
    reach();
  }, 30_000);

  test("EditableSidebarPanel", async () => {
    const { tally, reach } = tallied();
    await fc.assert(fc.asyncProperty(titleCase, async (c) => {
      serve(c);
      const view = render(
        <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
          <SyncContext.Provider value={makeSync()}>
            <EditableSidebarPanel title={rawTitleOf(c.variant)} />
          </SyncContext.Provider>
        </MemoryRouter>);
      try {
        await expectKeyedByCanonical(view, c);
      } finally {
        view.unmount();
        vi.unstubAllGlobals();
      }
      tally[c.kind] += 1;
    }), { numRuns: 40 });
    reach();
  }, 30_000);

  test("the page view, opened at the variant's /page/ URL", async () => {
    const { tally, reach } = tallied();
    await fc.assert(fc.asyncProperty(titleCase, async (c) => {
      serve(c);
      const view = render(
        <MemoryRouter future={ROUTER_FUTURE_FLAGS}
                      initialEntries={[pagePath(rawTitleOf(c.variant))]}>
          <SyncContext.Provider value={makeSync()}>
            <MainRoutes />
          </SyncContext.Provider>
        </MemoryRouter>);
      try {
        await expectKeyedByCanonical(view, c);
      } finally {
        view.unmount();
        vi.unstubAllGlobals();
      }
      tally[c.kind] += 1;
    }), { numRuns: 40 });
    reach();
  }, 30_000);
});
