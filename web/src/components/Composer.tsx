// pattern: Imperative Shell
// Phone-only (CSS) fixed bottom composer: append a top-level block to the
// current page with [[ autocomplete and camera/photo-library upload.
import { useRef, useState } from "react";
import { applyCompletion, detectAutocomplete,
         type AcContext } from "../outline/autocomplete";
import { autocompleteKeyAction } from "../outline/keyboardPolicy";
import { assetMarkdown, uploadAsset } from "../sync/assets";
import { AutocompletePopup, buildRows, useTitleOptions } from "./AutocompletePopup";

export function Composer({ onSend, readOnly }: {
  onSend: (text: string) => void;
  readOnly: boolean;
}) {
  const [draft, setDraft] = useState("");
  const [ac, setAc] = useState<AcContext | null>(null);
  const [acSelected, setAcSelected] = useState(0);
  const [caret, setCaret] = useState(0);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const options = useTitleOptions(ac ? ac.query : null);
  const acRows = ac ? buildRows(options, ac.query) : [];

  const send = () => {
    const text = draft.trim();
    if (text === "") return;
    onSend(text);
    setDraft("");
    setAc(null);
  };

  const pick = (row: { title: string }) => {
    if (!ac) return;
    const applied = applyCompletion(draft, caret, ac, row.title);
    setDraft(applied.text);
    setAc(null);
    setAcSelected(0);
    requestAnimationFrame(() => {
      taRef.current?.setSelectionRange(applied.cursor, applied.cursor);
    });
  };

  const onChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setDraft(e.target.value);
    setCaret(e.target.selectionStart);
    setAcSelected(0);
    setAc(detectAutocomplete(e.target.value, e.target.selectionStart));
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (acRows.length === 0) return;
    // Shared with the outline editor (pkm-clt1): only unmodified Arrow/
    // Enter/Tab/Escape are consumed here, so Cmd/Ctrl/Shift/Alt variants
    // reach native textarea behaviour instead of navigating the popup.
    const action = autocompleteKeyAction(e);
    if (!action) return;
    e.preventDefault();
    if (action === "move-down") { setAcSelected((s) => Math.min(s + 1, acRows.length - 1)); return; }
    if (action === "move-up") { setAcSelected((s) => Math.max(s - 1, 0)); return; }
    if (action === "pick") { pick(acRows[acSelected]); return; }
    if (action === "close") { setAc(null); return; }
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
                  onChange={onChange} onKeyDown={onKeyDown} />
        <AutocompletePopup rows={acRows} selected={acSelected} onPick={pick} />
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
