// run() refuses a command whose ops would store a block text past the text
// limits (length in code points, [[ nesting): none of the command's ops
// apply or ship, the pending draft's text still does, and the outline raises
// the limit's notice in the one edit-notice slot it shares with the depth
// cap. The editor reports a refused keystroke into the same slot.
import { act, render } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { BlockNode } from "../api/payloads";
import { LINK_NESTING_NOTICE,
         TEXT_LENGTH_NOTICE } from "../grammar/textLimits";
import { TITLE_LENGTH_NOTICE } from "../grammar/titleLength";
import { sha256Hex } from "../replica/sha256";
import { SyncContext } from "../sync/SyncProvider";
import { block, canonicalTitleOf, makeSync, orderIdxOf, type SyncFake,
         uidOf } from "../test-helpers";
import { findNode } from "./tree";
import { performUndo, resetHistory } from "./undoManager";
import { useOutline, type Outline } from "./useOutline";

vi.mock("../uid", () => {
  let n = 0;
  const next = () => `n${++n}`;
  return {
    newUid: next, newRawUid: next, newClientId: next, newBatchId: next,
  };
});

const PAGE = "Limits";
const nest = (n: number) => "[[a//".repeat(n) + "x" + "]]".repeat(n);
// A closed fence hides the nest; split just before the closer and the first
// half's fence is unclosed, so its nest counts.
const FENCED = "```\n" + nest(40) + "\n```";
const BEFORE_CLOSER = FENCED.length - "\n```".length;
const HALF = "h".repeat(600_000);

function Harness({ initial, onReady }: {
  initial: BlockNode[];
  onReady: (o: Outline) => void;
}) {
  const outline = useOutline(canonicalTitleOf(PAGE), initial);
  useEffect(() => onReady(outline));
  return null;
}

function setup(sync: SyncFake) {
  let outline!: Outline;
  render(
    <SyncContext.Provider value={sync}>
      <Harness initial={tree()} onReady={(o) => { outline = o; }} />
    </SyncContext.Provider>);
  return () => outline;
}

function tree(): BlockNode[] {
  return [
    block("tuid-fence", FENCED, { order_idx: orderIdxOf(0) }),
    block("tuid-big1", HALF, { order_idx: orderIdxOf(1) }),
    block("tuid-big2", HALF, { order_idx: orderIdxOf(2) }),
    block("tuid-small", "small", { order_idx: orderIdxOf(3) }),
  ];
}

const textOf = (o: Outline, raw: string) =>
  findNode(o.blocks, uidOf(raw))?.text;

afterEach(() => resetHistory());

it("a split that leaves an unclosed fence over a deep nest is refused",
   () => {
  const sync = makeSync();
  const outline = setup(sync);
  const before = outline().blocks;

  act(() => outline().handlers.onSplit(uidOf("tuid-fence"), BEFORE_CLOSER));

  expect(sync.sent).toEqual([]);
  expect(outline().blocks).toEqual(before);
  expect(outline().editNotice).toBe(LINK_NESTING_NOTICE);
  // nothing was recorded: there is no entry to undo
  expect(performUndo(sync)).toBe(false);
});

it("a merge past the length cap is refused with the length notice", () => {
  const sync = makeSync();
  const outline = setup(sync);
  const before = outline().blocks;

  act(() => outline().handlers.onBackspaceAtStart(uidOf("tuid-big2")));

  expect(sync.sent).toEqual([]);
  expect(outline().blocks).toEqual(before);
  expect(outline().editNotice).toBe(TEXT_LENGTH_NOTICE);
});

it("an outline paste with one line past the length cap applies nothing",
   () => {
  const sync = makeSync();
  const outline = setup(sync);
  const before = outline().blocks;

  act(() => outline().handlers.onPasteOutline(
    uidOf("tuid-small"), 5, 5, `a\n${"z".repeat(1_000_001)}`));

  expect(sync.sent).toEqual([]);
  expect(outline().blocks).toEqual(before);
  expect(outline().editNotice).toBe(TEXT_LENGTH_NOTICE);
});

it("an outline paste with a line linking a title past the cap applies "
   + "nothing", () => {
  const sync = makeSync();
  const outline = setup(sync);
  const before = outline().blocks;

  act(() => outline().handlers.onPasteOutline(
    uidOf("tuid-small"), 5, 5, `a\nsee [[${"t".repeat(1001)}]]`));

  expect(sync.sent).toEqual([]);
  expect(outline().blocks).toEqual(before);
  expect(outline().editNotice).toBe(TITLE_LENGTH_NOTICE);
});

it("a refused command still ships and applies the block's draft", () => {
  const sync = makeSync();
  const outline = setup(sync);
  act(() => outline().handlers.onFocusBlock(uidOf("tuid-big2"), 0));
  act(() => outline().handlers.onDraftStart(uidOf("tuid-big2"), HALF));
  act(() => outline().handlers.onDraftChange(uidOf("tuid-big2"), `${HALF}!`));

  act(() => outline().handlers.onBackspaceAtStart(uidOf("tuid-big2")));

  expect(sync.sent).toEqual([[
    { op: "update_text", uid: "tuid-big2", text: `${HALF}!`,
      base_text_hash: sha256Hex(HALF), page_title: PAGE },
  ]]);
  expect(textOf(outline(), "tuid-big2")).toBe(`${HALF}!`);
  expect(textOf(outline(), "tuid-big1")).toBe(HALF);
  expect(outline().editNotice).toBe(TEXT_LENGTH_NOTICE);
});

it("the next command that applies clears the notice", () => {
  const sync = makeSync();
  const outline = setup(sync);
  act(() => outline().handlers.onBackspaceAtStart(uidOf("tuid-big2")));
  expect(outline().editNotice).toBe(TEXT_LENGTH_NOTICE);

  act(() => outline().handlers.onSplit(uidOf("tuid-small"), 2));

  expect(sync.sent).toHaveLength(1);
  expect(textOf(outline(), "tuid-small")).toBe("sm");
  expect(outline().editNotice).toBeNull();
});

it("an edit the editor refused raises its notice, which dismisses", () => {
  const sync = makeSync();
  const outline = setup(sync);

  act(() => outline().handlers.onRefusedEdit(LINK_NESTING_NOTICE));

  expect(outline().editNotice).toBe(LINK_NESTING_NOTICE);
  expect(sync.sent).toEqual([]);

  act(() => outline().dismissEditNotice());

  expect(outline().editNotice).toBeNull();
});
