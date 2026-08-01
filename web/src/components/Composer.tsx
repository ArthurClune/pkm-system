// pattern: Imperative Shell
// Phone-only (CSS) fixed bottom composer: append a top-level block to the
// current page with [[ autocomplete and camera/photo-library upload.
import { useRef, useState } from "react";
import { applyCompletion } from "../outline/autocomplete";
import { useAutocomplete } from "../outline/useAutocomplete";
import { autocompleteKeyAction } from "../outline/keyboardPolicy";
import { assetMarkdown, uploadAsset } from "../sync/assets";
import { AutocompletePopup, buildRows, useTitleOptions } from "./AutocompletePopup";

export function Composer({ onSend, readOnly }: {
  onSend: (text: string) => void;
  readOnly: boolean;
}) {
  const [draft, setDraft] = useState("");
  // Shared with the outline editor's BlockInput (pkm-noow): the caret a pick
  // splices at is read live off the textarea, never remembered from the last
  // keystroke, so a click or selection-only move can't leave a completion
  // pointing at where the caret used to be.
  const ac = useAutocomplete();
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const options = useTitleOptions(ac.ctx ? ac.ctx.query : null);
  const acRows = ac.ctx ? buildRows(options, ac.ctx.query) : [];

  const send = () => {
    const text = draft.trim();
    if (text === "") return;
    onSend(text);
    setDraft("");
    ac.close();
  };

  const pick = (row: { title: string }) => {
    const target = ac.resolve(taRef.current);
    if (!target) return; // caret has moved off the token; resolve closed it
    const applied = applyCompletion(target.text, target.caret, target.ctx,
                                    row.title);
    setDraft(applied.text);
    ac.close();
    requestAnimationFrame(() => {
      taRef.current?.setSelectionRange(applied.cursor, applied.cursor);
    });
  };

  const onChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setDraft(e.target.value);
    ac.onEdit(e.target.value, e.target.selectionStart);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // A stale popup must not claim the key — an Enter here is a newline, not
    // a pick at a caret the user has left (pkm-noow).
    if (!ac.resolve(e.currentTarget) || acRows.length === 0) return;
    // Shared with the outline editor (pkm-clt1): only unmodified Arrow/
    // Enter/Tab/Escape are consumed here, so Cmd/Ctrl/Shift/Alt variants
    // reach native textarea behaviour instead of navigating the popup.
    const action = autocompleteKeyAction(e);
    if (!action) return;
    e.preventDefault();
    if (action === "move-down") { ac.setSelected((s) => Math.min(s + 1, acRows.length - 1)); return; }
    if (action === "move-up") { ac.setSelected((s) => Math.max(s - 1, 0)); return; }
    if (action === "pick") { pick(acRows[ac.selected]); return; }
    if (action === "close") { ac.close(); return; }
  };

  const onPickFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (readOnly) return;
    const file = e.target.files?.[0];
    e.target.value = ""; // same photo can be picked twice
    if (!file) return;
    void uploadAsset(file).then((info) => {
      setDraft((d) => (d === "" ? "" : d + " ") + assetMarkdown(info));
    }).catch(() => undefined);
  };

  return (
    <div className="composer">
      <div className="composer-input-wrap">
        <textarea ref={taRef} className="input-control"
                  aria-label="Add to this page" rows={1}
                  placeholder="Add to this page…" value={draft}
                  disabled={readOnly}
                  onChange={onChange} onKeyDown={onKeyDown}
                  onClick={(e) => ac.resolve(e.currentTarget)} />
        <AutocompletePopup rows={acRows} selected={ac.selected} onPick={pick} />
      </div>
      <input type="file" accept="image/*" aria-label="Add photo"
             className="composer-file" onChange={onPickFile} disabled={readOnly} />
      <button className="composer-send btn-secondary" onClick={send}
              disabled={readOnly || draft.trim() === ""}>
        Add
      </button>
    </div>
  );
}
