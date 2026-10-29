// pattern: Imperative Shell
// The app-level notice for drafts an outline dropped unsaved
// (outline/droppedDrafts.ts). It shows the start of each text and copies
// the whole of it. A clipped preview says so, and a failed copy shows the
// full text to select by hand, so no text is lost without the user seeing.
import { useState, useSyncExternalStore } from "react";
import { dismissDroppedDraft, droppedDrafts, subscribeDroppedDrafts,
         type DroppedDraft } from "../outline/droppedDrafts";

export const DROPPED_PREVIEW_CHARS = 280;

function DroppedDraftBanner({ draft }: { draft: DroppedDraft }) {
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
  const chars = Array.from(draft.text);
  const clipped = chars.length > DROPPED_PREVIEW_CHARS;
  const preview = clipped
    ? chars.slice(0, DROPPED_PREVIEW_CHARS).join("") + "…" : draft.text;
  // Inside the promise chain, so a missing Clipboard API (an insecure
  // origin) or a synchronous throw also shows the text to select.
  const copyText = () => {
    void Promise.resolve()
      .then(() => navigator.clipboard.writeText(draft.text))
      .then(() => setCopy("copied"), () => setCopy("failed"));
  };
  return (
    <div className="ws-banner dropped-draft" role="alert">
      <p>
        Unsaved text on “{draft.pageTitle}” could not be saved. {draft.notice}{" "}
        Copy it, and paste it back with the title fixed.
      </p>
      <p className="dropped-draft-text">{preview}</p>
      {clipped && (
        <p>
          Showing the first {DROPPED_PREVIEW_CHARS} of {chars.length}{" "}
          characters. Copy copies all of them.
        </p>
      )}
      {copy === "failed" && (
        <>
          <p>Copying failed. Select the text below and copy it.</p>
          <textarea readOnly value={draft.text} aria-label="Unsaved text" />
        </>
      )}
      <button type="button" onClick={copyText}>
        {copy === "copied" ? "Copied" : "Copy"}
      </button>
      <button type="button" onClick={() => dismissDroppedDraft(draft.id)}>
        Dismiss
      </button>
    </div>
  );
}

export function DroppedDraftNotice() {
  const drafts = useSyncExternalStore(subscribeDroppedDrafts, droppedDrafts);
  return <>{drafts.map((d) => <DroppedDraftBanner key={d.id} draft={d} />)}</>;
}
