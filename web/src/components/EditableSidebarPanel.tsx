// pattern: Imperative Shell
// Loads one page for a sidebar panel through the shared outline page-load
// controller (useOutlinePageLoad, the same one the main pane uses) and
// renders it through EditablePage — the same useOutline machinery, op
// queue, and live websocket sync as the main pane, instead of the old
// one-shot read-only fetch. (EditablePage itself handles the case where
// this title is already open elsewhere in the tab, falling back to
// read-only there.) All that is left here is presentation: the panel's own
// error/loading text and the scoped scroll below.
//
// An optional uid (pkm-gdi5, a block ref or asset link opened with
// shift-click) is scrolled to and flashed once the page has rendered --
// scoped to this panel's OWN container via containerRef, never a
// document-wide query: the same page can be open in the main window at
// the same time, with its own element carrying that data-uid.
import { useRef } from "react";
import { BlockRefProvider } from "./BlockRefProvider";
import { substituteMissingDaily } from "../outline/missingPage";
import { useOutlinePageLoad } from "../outline/useOutlinePageLoad";
import { useScrollFlashTarget } from "../useScrollFlashTarget";
import { EditablePage } from "../views/EditablePage";

export function EditableSidebarPanel({ title, uid }: { title: string; uid?: string }) {
  const { payload, error } = useOutlinePageLoad(title, substituteMissingDaily);
  const containerRef = useRef<HTMLDivElement>(null);

  useScrollFlashTarget(uid, payload, containerRef);

  if (error) return <p className="error">{error}</p>;
  if (!payload) return <p className="loading">Loading…</p>;
  return (
    <div ref={containerRef}>
      <BlockRefProvider seed={payload.block_ref_texts}>
        <EditablePage title={title} initial={payload.blocks} />
      </BlockRefProvider>
    </div>
  );
}
