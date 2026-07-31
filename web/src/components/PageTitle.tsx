// pattern: Imperative Shell
// Click-to-edit page title (pkm-g0t5). Enter/blur commit, Escape reverts.
// A commit POSTs /rename with allow_merge=false; a 409 means the title is
// taken, so ask (same in-app confirm dialog as Delete page, pkm-pe79) and
// retry with allow_merge=true. Daily notes are not editable (server
// rejects them too). The server is atomic, so any failure = clean revert.
import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ApiError, apiFetch } from "../api/client";
import { encodeTitle, pagePath } from "../paths";
import { dateForTitle } from "../replica/daily";
import { useConfirm } from "./ConfirmDialog";

interface RenameResult {
  result: "renamed" | "merged";
  title: string;
}

export function PageTitle({ title }: { title: string }) {
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelledRef = useRef(false);
  const navigate = useNavigate();
  const editable = dateForTitle(title) === null;
  const { confirm, dialog } = useConfirm();

  const rename = (newTitle: string, allowMerge: boolean) =>
    apiFetch<RenameResult>(`/api/page/${encodeTitle(title)}/rename`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ new_title: newTitle, allow_merge: allowMerge }),
    });

  const commit = async (value: string) => {
    setEditing(false);
    const newTitle = value.trim();
    if (!newTitle || newTitle === title) return;
    try {
      const r = await rename(newTitle, false);
      navigate(pagePath(r.title));
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        const ok = await confirm(
          `Page "${newTitle}" already exists — merge this page into it?`,
          { confirmLabel: "Merge" });
        if (!ok) return;
        try {
          const r = await rename(newTitle, true);
          navigate(pagePath(r.title));
        } catch (retryError) {
          setError(String(retryError));
        }
        return;
      }
      setError(String(e));
    }
  };

  if (!editing) {
    const startEditing = () => {
      cancelledRef.current = false;
      setError(null);
      setEditing(true);
    };
    return (
      <>
        {/* The affordance is a real button inside the heading (pkm-l4z8):
          * an onClick on the <h1> itself was unreachable from the keyboard.
          * The heading keeps its place in the document outline and the button
          * inherits its type, so nothing moves visually. aria-label is fixed
          * text rather than the title itself: an arbitrary title can contain
          * any word (an e2e page named "...Cancel..." or "Merge A g0t5"
          * turned this button into a second match for getByRole("button",
          * { name: "Cancel" }) / { name: "Merge" }) elsewhere on the page --
          * a strict-mode violation or a wrong-element click, deterministic
          * every time such a title is used, not a timing flake. */}
        <h1 className={`page-title${editable ? " page-title-editable" : ""}`}>
          {editable
            ? (
              <button type="button" className="page-title-edit"
                      aria-label="Edit title" onClick={startEditing}>
                {title}
              </button>
            )
            : title}
        </h1>
        {error !== null && <p className="error">{error}</p>}
        {dialog}
      </>
    );
  }
  return (
    <>
      <input className="page-title page-title-input" defaultValue={title}
             aria-label="Page title"
             autoFocus
             onKeyDown={(e) => {
               if (e.key === "Enter") {
                 e.preventDefault();
                 e.currentTarget.blur(); // commit runs in onBlur, exactly once
               } else if (e.key === "Escape") {
                 cancelledRef.current = true;
                 e.currentTarget.blur();
               }
             }}
             onBlur={(e) => {
               if (cancelledRef.current) {
                 cancelledRef.current = false;
                 setEditing(false);
                 return;
               }
               void commit(e.currentTarget.value);
             }} />
      {dialog}
    </>
  );
}
