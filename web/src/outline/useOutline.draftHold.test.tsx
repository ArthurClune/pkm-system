// A flush-held draft (caret mid [[ref / #tag token) must not
// autosave when the debounce elapses — that's what turned half-typed titles
// like "How LLM" into pages (the server creates a page for every ref it
// indexes). Explicit commit points (blur, structural edits) still flush.
import { act, render } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { BlockNode } from "../api/payloads";
import { SyncContext } from "../sync/SyncProvider";
import { sha256Hex } from "../replica/sha256";
import { block, clientIdOf, makeSync, orderIdxOf, type SyncFake, canonicalTitleOf, typeInto,
         uidOf, confirmYes } from "../test-helpers";
import { useOutline, type Outline } from "./useOutline";

function Harness({ titleText, initial, onReady }: {
  titleText: string; initial: BlockNode[]; onReady: (o: Outline) => void;
}) {
  const outline = useOutline(canonicalTitleOf(titleText), initial, confirmYes);
  useEffect(() => onReady(outline));
  return null;
}

function mountOutline(sync: SyncFake, titleText: string, initial: BlockNode[]) {
  let outline!: Outline;
  const { unmount } = render(
    <SyncContext.Provider value={sync}>
      <Harness titleText={titleText} initial={initial}
               onReady={(o) => { outline = o; }} />
    </SyncContext.Provider>);
  return { outline: () => outline, unmount };
}

function setup(sync: SyncFake, titleText: string, initial: BlockNode[]) {
  return mountOutline(sync, titleText, initial).outline;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const PAGE = "Draft Hold";
const one = () => [block("tuid-a", "", { order_idx: orderIdxOf(0) })];

it("a held draft does not flush when the debounce elapses", () => {
  const sync = makeSync();
  const outline = setup(sync, PAGE, one());
  act(() => outline().handlers.onFocusBlock(uidOf("tuid-a"), 0));
  act(() => typeInto(outline(), uidOf("tuid-a"), "[[How LLM]]", true));
  act(() => { vi.advanceTimersByTime(5000); });
  expect(sync.sent).toHaveLength(0);
});

it("a held draft cancels an already-armed debounce for the same block", () => {
  const sync = makeSync();
  const outline = setup(sync, PAGE, one());
  act(() => outline().handlers.onFocusBlock(uidOf("tuid-a"), 0));
  act(() => typeInto(outline(), uidOf("tuid-a"), "see ")); // arms the timer
  act(() => typeInto(outline(), uidOf("tuid-a"), "see [[How LLM]]", true));
  act(() => { vi.advanceTimersByTime(5000); });
  expect(sync.sent).toHaveLength(0);
});

it("a later unheld draft resumes the normal debounce with the final text", () => {
  const sync = makeSync();
  const outline = setup(sync, PAGE, one());
  act(() => outline().handlers.onFocusBlock(uidOf("tuid-a"), 0));
  act(() => typeInto(outline(), uidOf("tuid-a"), "[[How LLM]]", true));
  act(() => { vi.advanceTimersByTime(5000); });
  // completion picked: caret lands after the closer, no longer held
  act(() => typeInto(outline(), uidOf("tuid-a"), "[[How LLMs Work]] "));
  act(() => { vi.advanceTimersByTime(600); });
  expect(sync.sent).toEqual([
    [{ op: "update_text", uid: "tuid-a", text: "[[How LLMs Work]] ",
      base_text_hash: sha256Hex(""), page_title: PAGE }],
  ]);
});

it("blur still flushes a held draft (explicit commit point)", () => {
  const sync = makeSync();
  const outline = setup(sync, PAGE, one());
  act(() => outline().handlers.onFocusBlock(uidOf("tuid-a"), 0));
  act(() => typeInto(outline(), uidOf("tuid-a"), "[[How LLM]]", true));
  act(() => outline().handlers.onBlurBlock(uidOf("tuid-a")));
  expect(sync.sent).toEqual([
    [{ op: "update_text", uid: "tuid-a", text: "[[How LLM]]",
      base_text_hash: sha256Hex(""), page_title: PAGE }],
  ]);
});

// Navigating away (Ctrl-O over the very ref being typed) unmounts
// the tree with no blur, so the tree asks for the flush explicitly.
it("an explicit draft flush commits a held draft (navigation)", () => {
  const sync = makeSync();
  const outline = setup(sync, PAGE, one());
  act(() => outline().handlers.onFocusBlock(uidOf("tuid-a"), 0));
  act(() => typeInto(outline(), uidOf("tuid-a"), "[[How LLM]]", true));
  act(() => { outline().handlers.onFlushDraft(); });
  expect(sync.sent).toEqual([
    [{ op: "update_text", uid: "tuid-a", text: "[[How LLM]]",
      base_text_hash: sha256Hex(""), page_title: PAGE }],
  ]);
});

// An ordinary draft survives an unmount on its own — nothing
// cancels the pending debounce, so it fires after the outline is gone. A HELD
// draft has no timer at all, and React delivers no blur for a node it removes,
// so unmounting is itself a commit point.
it("unmounting flushes a held draft (navigation with no blur)", () => {
  const sync = makeSync();
  const h = mountOutline(sync, PAGE, one());
  act(() => h.outline().handlers.onFocusBlock(uidOf("tuid-a"), 0));
  act(() => typeInto(h.outline(), uidOf("tuid-a"), "[[How LLM]]", true));
  act(() => h.unmount());
  expect(sync.sent).toEqual([
    [{ op: "update_text", uid: "tuid-a", text: "[[How LLM]]",
      base_text_hash: sha256Hex(""), page_title: PAGE }],
  ]);
});

it("unmounting an untouched outline sends nothing", () => {
  const sync = makeSync();
  const h = mountOutline(sync, PAGE, one());
  act(() => h.unmount());
  expect(sync.sent).toEqual([]);
});

it("a structural edit still flushes a held draft first", () => {
  const sync = makeSync();
  const outline = setup(sync, PAGE, one());
  act(() => outline().handlers.onFocusBlock(uidOf("tuid-a"), 0));
  act(() => typeInto(outline(), uidOf("tuid-a"), "[[How LLM]]", true));
  act(() => outline().handlers.onIndent(uidOf("tuid-a"))); // no-op move, but flushes
  expect(sync.sent.flat()).toContainEqual(
    { op: "update_text", uid: "tuid-a", text: "[[How LLM]]",
      base_text_hash: sha256Hex(""), page_title: PAGE });
});

it("a change with no open draft records nothing", () => {
  const sync = makeSync();
  const outline = setup(sync, PAGE, one());
  act(() => outline().handlers.onDraftChange(uidOf("tuid-a"), "x"));
  act(() => { vi.advanceTimersByTime(5000); });
  expect(outline().handlers.pendingDraft(uidOf("tuid-a"))).toBeNull();
  expect(sync.sent).toEqual([]);
});

it("a new draft does not replace another block's draft that may not be saved", () => {
  const sync = makeSync();
  const outline = setup(sync, PAGE, [
    block("tuid-a", "", { order_idx: orderIdxOf(0) }),
    block("tuid-b", "b text", { order_idx: orderIdxOf(1) }),
  ]);
  act(() => typeInto(outline(), uidOf("tuid-a"), "see [[a#b]]"));
  act(() => outline().handlers.onDraftStart(uidOf("tuid-b"), "b text"));
  act(() => outline().handlers.onDraftChange(uidOf("tuid-b"), "b text!"));
  act(() => { vi.advanceTimersByTime(5000); });
  expect(outline().handlers.pendingDraft(uidOf("tuid-a"))?.text).toBe("see [[a#b]]");
  expect(outline().handlers.pendingDraft(uidOf("tuid-b"))).toBeNull();
  expect(sync.sent).toEqual([]);
});

it("a draft after a flush bases on the shown text, not the flushed text", () => {
  const sync = makeSync();
  const outline = setup(sync, PAGE, one());
  act(() => typeInto(outline(), uidOf("tuid-a"), "flushed"));
  act(() => { outline().handlers.onFlushDraft(); });
  act(() => sync.emit({ client_id: clientIdOf("other"), ts: 1, ops: [
    { op: "update_text", uid: uidOf("tuid-a"), text: "remote" },
  ] }));
  act(() => outline().handlers.onDraftStart(uidOf("tuid-a"), "remote"));
  act(() => outline().handlers.onDraftChange(uidOf("tuid-a"), "remote!"));
  act(() => { outline().handlers.onFlushDraft(); });
  expect(sync.sent[sync.sent.length - 1]).toEqual([
    { op: "update_text", uid: "tuid-a", text: "remote!",
      base_text_hash: sha256Hex("remote"), page_title: PAGE },
  ]);
});
