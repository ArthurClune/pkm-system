// Multi-block selection move + delete, wired through useOutline's
// handlers (the imperative half — confirm() gating and op dispatch — of the
// pure moveSelectionUp/moveSelectionDown/deleteSelection in edits.ts).
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { BlockNode } from "../api/payloads";
import { SyncContext } from "../sync/SyncProvider";
import { subtreeHash } from "../replica/subtreeHash";
import { block, makeSync, orderIdxOf, canonicalTitleOf, type SyncFake, uidOf } from "../test-helpers";
import { useOutline, type Outline } from "./useOutline";

function Harness({ pageTitle, initial, onReady }: {
  pageTitle: string;
  initial: BlockNode[];
  onReady: (o: Outline) => void;
}) {
  const outline = useOutline(canonicalTitleOf(pageTitle), initial);
  useEffect(() => onReady(outline));
  return <>{outline.dialog}</>;
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

const abc = () => [
  block("tuid-a", "alpha", { order_idx: orderIdxOf(0) }),
  block("tuid-b", "beta", { order_idx: orderIdxOf(1) }),
  block("tuid-c", "gamma", { order_idx: orderIdxOf(2) }),
];

const crossParentTree = () => [
  block("tuid-a", "A", {
    order_idx: orderIdxOf(0),
    children: [block("tuid-a0", "A child", { order_idx: orderIdxOf(0) })],
  }),
  block("tuid-b", "B", {
    order_idx: orderIdxOf(1),
    children: [
      block("tuid-b0", "B first", {
        order_idx: orderIdxOf(0),
        children: [block("tuid-b0x", "B grandchild", { order_idx: orderIdxOf(0) })],
      }),
      block("tuid-b1", "B second", { order_idx: orderIdxOf(1) }),
    ],
  }),
  block("tuid-c", "C", { order_idx: orderIdxOf(2) }),
];

afterEach(() => {
  vi.restoreAllMocks();
});

it("onMoveSelectionUp moves every selected block as a group, not just one", () => {
  const sync = makeSync();
  const getOutline = setup(sync, "Page", abc());
  act(() => getOutline().handlers.onStartBlockSelection(uidOf("tuid-b"), "down")); // anchor b, head c
  expect(getOutline().selection).toEqual({ anchor: "tuid-b", head: "tuid-c" });

  act(() => getOutline().handlers.onMoveSelectionUp());

  expect(sync.sent).toEqual([
    [{ op: "move", uid: "tuid-a", parent_uid: null, order_idx: 3 }],
  ]);
  expect(getOutline().blocks.map((b) => b.uid)).toEqual(["tuid-b", "tuid-c", "tuid-a"]);
  // the selection is unaffected — b and c never moved themselves
  expect(getOutline().selection).toEqual({ anchor: "tuid-b", head: "tuid-c" });
});

it("onMoveSelectionDown moves every selected block as a group", () => {
  const sync = makeSync();
  const getOutline = setup(sync, "Page", abc());
  act(() => getOutline().handlers.onStartBlockSelection(uidOf("tuid-a"), "down")); // anchor a, head b

  act(() => getOutline().handlers.onMoveSelectionDown());

  expect(sync.sent).toEqual([
    [{ op: "move", uid: "tuid-c", parent_uid: null, order_idx: 0 }],
  ]);
  expect(getOutline().blocks.map((b) => b.uid)).toEqual(["tuid-c", "tuid-a", "tuid-b"]);
});

it("queues and applies one cross-parent selection move batch", () => {
  const sync = makeSync();
  const getOutline = setup(sync, "Page", crossParentTree());
  act(() => getOutline().handlers.onStartBlockSelection(uidOf("tuid-b0"), "down"));
  act(() => getOutline().handlers.onExtendBlockSelection("down"));
  expect(getOutline().selection).toEqual({ anchor: "tuid-b0", head: "tuid-b1" });

  act(() => getOutline().handlers.onMoveSelectionUp());

  expect(sync.sent).toEqual([[
    { op: "move", uid: "tuid-b0", parent_uid: "tuid-a", order_idx: 1 },
    { op: "move", uid: "tuid-b1", parent_uid: "tuid-a", order_idx: 2 },
  ]]);
  expect(getOutline().blocks.map((n) => n.uid)).toEqual(["tuid-a", "tuid-b", "tuid-c"]);
  expect(getOutline().blocks[0].children.map((n) => n.uid))
    .toEqual(["tuid-a0", "tuid-b0", "tuid-b1"]);
  expect(getOutline().blocks[0].children[1].children.map((n) => n.uid))
    .toEqual(["tuid-b0x"]);
  expect(getOutline().selection).toEqual({ anchor: "tuid-b0", head: "tuid-b1" });
});

it("does not enqueue when one selected movement run is ineligible", () => {
  const sync = makeSync();
  const getOutline = setup(sync, "Page", crossParentTree());
  act(() => getOutline().handlers.onStartBlockSelection(uidOf("tuid-a0"), "down"));
  expect(getOutline().selection).toEqual({ anchor: "tuid-a0", head: "tuid-b" });

  act(() => getOutline().handlers.onMoveSelectionUp());

  expect(sync.sent).toEqual([]);
  expect(getOutline().blocks.map((n) => n.uid)).toEqual(["tuid-a", "tuid-b", "tuid-c"]);
  expect(getOutline().selection).toEqual({ anchor: "tuid-a0", head: "tuid-b" });
});

it("indents and outdents the selected run as one batch without clearing it", () => {
  const sync = makeSync();
  const getOutline = setup(sync, "Page", abc());
  act(() => getOutline().handlers.onStartBlockSelection(uidOf("tuid-b"), "down"));

  act(() => getOutline().handlers.onIndentSelection());

  expect(sync.sent).toEqual([[
    { op: "move", uid: "tuid-b", parent_uid: "tuid-a", order_idx: 0 },
    { op: "move", uid: "tuid-c", parent_uid: "tuid-a", order_idx: 1 },
  ]]);
  expect(getOutline().blocks.map((b) => b.uid)).toEqual(["tuid-a"]);
  expect(getOutline().blocks[0].children.map((b) => b.uid))
    .toEqual(["tuid-b", "tuid-c"]);
  expect(getOutline().selection).toEqual({ anchor: "tuid-b", head: "tuid-c" });

  act(() => getOutline().handlers.onOutdentSelection());

  expect(sync.sent[1]).toEqual([
    { op: "move", uid: "tuid-b", parent_uid: null, order_idx: 1 },
    { op: "move", uid: "tuid-c", parent_uid: null, order_idx: 2 },
  ]);
  expect(getOutline().blocks.map((b) => b.uid)).toEqual(["tuid-a", "tuid-b", "tuid-c"]);
  expect(getOutline().selection).toEqual({ anchor: "tuid-b", head: "tuid-c" });
});

it("keeps the whole selection unchanged when one indent run is ineligible", () => {
  const sync = makeSync();
  const getOutline = setup(sync, "Page", abc());
  act(() => getOutline().handlers.onStartBlockSelection(uidOf("tuid-a"), "down"));

  act(() => getOutline().handlers.onIndentSelection());

  expect(sync.sent).toEqual([]);
  expect(getOutline().blocks.map((b) => b.uid)).toEqual(["tuid-a", "tuid-b", "tuid-c"]);
  expect(getOutline().selection).toEqual({ anchor: "tuid-a", head: "tuid-b" });
});

it("onSelectBlock selects exactly that block and ends editing", () => {
  const sync = makeSync();
  const getOutline = setup(sync, "Page", abc());
  act(() => getOutline().handlers.onFocusBlock(uidOf("tuid-b"), 2));

  act(() => getOutline().handlers.onSelectBlock(uidOf("tuid-b")));

  expect(getOutline().selection).toEqual({ anchor: "tuid-b", head: "tuid-b" });
  expect(getOutline().focus).toBeNull();

  // further Ctrl+Cmd presses extend one block at a time from that anchor
  act(() => getOutline().handlers.onExtendBlockSelection("down"));
  expect(getOutline().selection).toEqual({ anchor: "tuid-b", head: "tuid-c" });
});

it("deleting 20 or fewer selected blocks proceeds without confirmation", () => {
  const confirmSpy = vi.spyOn(window, "confirm"); // if this got called, the test should fail below
  const sync = makeSync();
  const getOutline = setup(sync, "Page", abc());
  act(() => getOutline().handlers.onStartBlockSelection(uidOf("tuid-a"), "down")); // a, b selected

  act(() => getOutline().handlers.onDeleteBlockSelection());

  expect(confirmSpy).not.toHaveBeenCalled();
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(sync.sent).toEqual([
    [{ op: "delete", uid: "tuid-a", base_subtree_hash: subtreeHash([["tuid-a", "alpha"]]) },
     { op: "delete", uid: "tuid-b", base_subtree_hash: subtreeHash([["tuid-b", "beta"]]) }],
  ]);
  expect(getOutline().blocks.map((b) => b.uid)).toEqual(["tuid-c"]);
  expect(getOutline().selection).toBeNull();
});

// 21 top-level blocks: one over LARGE_DELETE_THRESHOLD.
const MANY_UIDS = Array.from({ length: 21 }, (_, i) => `tuid-u${String(i).padStart(2, "0")}`);
function manyBlocks() {
  return MANY_UIDS.map((uid, i) => block(uid, uid, { order_idx: orderIdxOf(i) }));
}

// window.confirm is suppressed by iPadOS Safari in standalone/PWA
// mode, so the large-selection prompt goes through the app's own useConfirm
// dialog (a real, awaited DOM dialog) rather than window.confirm.
it("deleting more than 20 selected blocks requires "
  + "confirmation via the in-app dialog, and honours cancel", async () => {
  const confirmSpy = vi.spyOn(window, "confirm");
  const sync = makeSync();
  const getOutline = setup(sync, "Page", manyBlocks());
  act(() => getOutline().handlers.onStartBlockSelection(uidOf("tuid-u00"), "down"));
  for (let i = 0; i < MANY_UIDS.length - 2; i++) {
    act(() => getOutline().handlers.onExtendBlockSelection("down"));
  }
  expect(getOutline().selection).toEqual({ anchor: "tuid-u00", head: "tuid-u20" });

  act(() => getOutline().handlers.onDeleteBlockSelection());

  const dialog = screen.getByRole("alertdialog");
  // The delete is an ordinary undoable history entry (per-tab, lost on
  // reload), so the prompt must not claim it is irreversible.
  expect(dialog).toHaveTextContent("Delete 21 blocks? Cmd+Z undoes this until you reload.");
  expect(dialog).not.toHaveTextContent(/cannot be undone/i);
  expect(confirmSpy).not.toHaveBeenCalled(); // never touches window.confirm
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  });

  // cancelled: nothing sent, nothing deleted, selection untouched
  expect(sync.sent).toEqual([]);
  expect(getOutline().blocks.map((b) => b.uid)).toEqual(MANY_UIDS);
  expect(getOutline().selection).toEqual({ anchor: "tuid-u00", head: "tuid-u20" });
  expect(screen.queryByRole("alertdialog")).toBeNull();
});

it("deleting more than 20 selected blocks proceeds once confirmed in the dialog", async () => {
  const sync = makeSync();
  const getOutline = setup(sync, "Page", manyBlocks());
  act(() => getOutline().handlers.onStartBlockSelection(uidOf("tuid-u00"), "down"));
  for (let i = 0; i < MANY_UIDS.length - 2; i++) {
    act(() => getOutline().handlers.onExtendBlockSelection("down"));
  }

  act(() => getOutline().handlers.onDeleteBlockSelection());
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
  });

  expect(sync.sent).toEqual([
    MANY_UIDS.map((uid) => ({
      op: "delete", uid, base_subtree_hash: subtreeHash([[uid, uid]]),
    })),
  ]);
  expect(getOutline().blocks).toEqual([]);
  expect(getOutline().selection).toBeNull();
});
