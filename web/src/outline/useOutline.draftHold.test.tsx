// pkm-xlah: a flush-held draft (caret mid [[ref / #tag token) must not
// autosave when the debounce elapses — that's what turned half-typed titles
// like "How LLM" into pages (the server creates a page for every ref it
// indexes). Explicit commit points (blur, structural edits) still flush.
import { act, render } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { BlockNode } from "../api/payloads";
import { SyncContext } from "../sync/SyncProvider";
import { block, makeSync, type SyncFake } from "../test-helpers";
import { useOutline, type Outline } from "./useOutline";

function Harness({ pageTitle, initial, onReady }: {
  pageTitle: string; initial: BlockNode[]; onReady: (o: Outline) => void;
}) {
  const outline = useOutline(pageTitle, initial);
  useEffect(() => onReady(outline));
  return null;
}

function setup(sync: SyncFake, pageTitle: string, initial: BlockNode[]) {
  let outline!: Outline;
  render(
    <SyncContext.Provider value={sync}>
      <Harness pageTitle={pageTitle} initial={initial}
               onReady={(o) => { outline = o; }} />
    </SyncContext.Provider>);
  return () => outline;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const PAGE = "Draft Hold";
const one = () => [block("a", "", { order_idx: 0 })];

it("a held draft does not flush when the debounce elapses", () => {
  const sync = makeSync();
  const outline = setup(sync, PAGE, one());
  act(() => outline().handlers.onFocusBlock("a", 0));
  act(() => outline().handlers.onDraftChange("a", "[[How LLM]]", true));
  act(() => { vi.advanceTimersByTime(5000); });
  expect(sync.sent).toHaveLength(0);
});

it("a held draft cancels an already-armed debounce for the same block", () => {
  const sync = makeSync();
  const outline = setup(sync, PAGE, one());
  act(() => outline().handlers.onFocusBlock("a", 0));
  act(() => outline().handlers.onDraftChange("a", "see ")); // arms the timer
  act(() => outline().handlers.onDraftChange("a", "see [[How LLM]]", true));
  act(() => { vi.advanceTimersByTime(5000); });
  expect(sync.sent).toHaveLength(0);
});

it("a later unheld draft resumes the normal debounce with the final text", () => {
  const sync = makeSync();
  const outline = setup(sync, PAGE, one());
  act(() => outline().handlers.onFocusBlock("a", 0));
  act(() => outline().handlers.onDraftChange("a", "[[How LLM]]", true));
  act(() => { vi.advanceTimersByTime(5000); });
  // completion picked: caret lands after the closer, no longer held
  act(() => outline().handlers.onDraftChange("a", "[[How LLMs Work]] "));
  act(() => { vi.advanceTimersByTime(600); });
  expect(sync.sent).toEqual([
    [{ op: "update_text", uid: "a", text: "[[How LLMs Work]] " }],
  ]);
});

it("blur still flushes a held draft (explicit commit point)", () => {
  const sync = makeSync();
  const outline = setup(sync, PAGE, one());
  act(() => outline().handlers.onFocusBlock("a", 0));
  act(() => outline().handlers.onDraftChange("a", "[[How LLM]]", true));
  act(() => outline().handlers.onBlurBlock("a"));
  expect(sync.sent).toEqual([
    [{ op: "update_text", uid: "a", text: "[[How LLM]]" }],
  ]);
});

it("a structural edit still flushes a held draft first", () => {
  const sync = makeSync();
  const outline = setup(sync, PAGE, one());
  act(() => outline().handlers.onFocusBlock("a", 0));
  act(() => outline().handlers.onDraftChange("a", "[[How LLM]]", true));
  act(() => outline().handlers.onIndent("a")); // no-op move, but flushes
  expect(sync.sent.flat()).toContainEqual(
    { op: "update_text", uid: "a", text: "[[How LLM]]" });
});
