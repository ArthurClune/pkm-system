// pattern: Imperative Shell
// The open table cell: a one-row textarea and the popup under it, which holds
// the cell's hint, the column's repeated values, or page titles after `[[`
// or `#`. The draft belongs to the caller (DataTable's stepEditor state);
// this reports keys as commit, cancel, tab and outside, and picks into the
// draft. Never an <input>: iPad Safari with a hardware keyboard keeps Tab
// inside an <input> for its own field navigation, so the page never sees it.
import { useEffect, useLayoutEffect, useRef, useState,
         type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AutocompletePopup, buildRows, useTitleOptions,
         type TitleAcRow } from "../components/AutocompletePopup";
import { applyCompletion } from "../outline/autocomplete";
import { heightChanged, mayHaveShrunk } from "../outline/textareaHeight";
import { useAutocomplete } from "../outline/useAutocomplete";
import { supportsFieldSizing } from "../outline/useBlockDraft";
import { placeUnderAnchor } from "../popoverPosition";
import { decideCellKey, type CellList } from "./cellKeys";

export interface Suggestion { value: string; count: number }

const VIEWPORT_MARGIN = 12;
const POPUP_GAP = 2;

export function CellTextarea({ label, draft, onDraft, onCommit, onCancel, onTab,
                             onOutside, hint, suggest }: {
  label: string;
  draft: string;
  onDraft: (text: string) => void;
  onCommit: () => void;
  onCancel: () => void;
  onTab: (dir: 1 | -1) => void;
  onOutside: () => void;
  hint?: ReactNode;
  suggest?: (typed: string) => Suggestion[];
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const ac = useAutocomplete();
  const titleCtx = ac.ctx !== null && ac.ctx.kind !== "command" ? ac.ctx : null;
  const options = useTitleOptions(titleCtx ? titleCtx.query : null);
  const titleRows = titleCtx ? buildRows(options, titleCtx.query) : [];
  const titleSel = Math.min(ac.selected, Math.max(titleRows.length - 1, 0));
  const values = titleRows.length === 0 && suggest ? suggest(draft) : [];
  const [valueSel, setValueSel] = useState(-1);
  const valueSelected = Math.min(valueSel, values.length - 1);
  const hasHint = hint !== null && hint !== undefined && hint !== false;
  const showPopup = hasHint || titleRows.length > 0 || values.length > 0;
  // A pick sets the caret in a layout effect of the same commit, the timing
  // useAutocomplete's resolve() relies on.
  const pendingCaret = useRef<number | null>(null);
  const onOutsideRef = useRef(onOutside);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [scrolls, setScrolls] = useState(0);

  useLayoutEffect(() => { onOutsideRef.current = onOutside; });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el && pendingCaret.current !== null) {
      el.setSelectionRange(pendingCaret.current, pendingCaret.current);
    }
    pendingCaret.current = null;
  }, [draft]);

  const heightApplied = useRef<number | null>(null);
  const heightText = useRef(draft);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || supportsFieldSizing) return;
    if (mayHaveShrunk(heightText.current, draft)) el.style.height = "auto";
    heightText.current = draft;
    const measured = el.scrollHeight;
    if (heightChanged(measured, heightApplied.current)) {
      el.style.height = `${measured}px`;
      heightApplied.current = measured;
    }
  }, [draft]);

  // Capture phase: a mousedown on a surface that stops its propagation
  // (a popover, a link island) must still commit the cell.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (ref.current?.contains(target)
          || popupRef.current?.contains(target)) return;
      onOutsideRef.current();
    };
    const onScroll = () => setScrolls((n) => n + 1);
    document.addEventListener("mousedown", onDown, true);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, []);

  useLayoutEffect(() => {
    const el = ref.current;
    const popup = popupRef.current;
    if (!el || !popup) return;
    const box = popup.getBoundingClientRect();
    setPos(placeUnderAnchor({
      anchor: el.getBoundingClientRect(), width: box.width, height: box.height,
      viewportWidth: window.innerWidth, viewportHeight: window.innerHeight,
      margin: VIEWPORT_MARGIN, gap: POPUP_GAP,
    }));
  }, [showPopup, draft, titleRows.length, values.length, scrolls]);

  const setDraft = (text: string, caret: number) => {
    pendingCaret.current = caret;
    onDraft(text);
  };

  const pickTitle = (row: TitleAcRow) => {
    const target = ac.resolve(ref.current);
    if (!target) return;
    const applied = applyCompletion(target.text, target.caret, target.ctx,
                                    row.pageTitle);
    ac.close();
    setDraft(applied.text, applied.cursor);
  };

  const pickValue = (s: Suggestion) => {
    setValueSel(-1);
    setDraft(s.value, s.value.length);
  };

  const onChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const text = e.target.value;
    ac.onEdit(text, e.target.selectionStart ?? text.length);
    setValueSel(-1);
    onDraft(text);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const titlesLive = titleRows.length > 0
      && ac.resolve(e.currentTarget) !== null;
    const list: CellList | null = titlesLive
      ? { rows: titleRows.length, selected: titleSel, floor: 0, closable: true }
      : values.length > 0
        ? { rows: values.length, selected: valueSelected, floor: -1,
            closable: false }
        : null;
    const decision = decideCellKey({
      key: e.key, shiftKey: e.shiftKey, metaKey: e.metaKey,
      ctrlKey: e.ctrlKey, altKey: e.altKey,
      composing: e.nativeEvent.isComposing,
    }, list);
    if (decision.kind === "none") return;
    e.preventDefault();
    switch (decision.kind) {
      case "commit": onCommit(); return;
      case "cancel": onCancel(); return;
      case "tab": onTab(decision.dir); return;
      case "close-list": ac.close(); return;
      case "move":
        if (titlesLive) ac.setSelected(decision.selected);
        else setValueSel(decision.selected);
        return;
      case "pick":
        if (titlesLive) pickTitle(titleRows[titleSel]!);
        else pickValue(values[valueSelected]!);
        return;
      default: {
        const exhaustive: never = decision;
        return exhaustive;
      }
    }
  };

  return (
    <>
      <textarea ref={ref} className="cell-editor" rows={1} aria-label={label}
                value={draft} onChange={onChange} onKeyDown={onKeyDown}
                onClick={(e) => ac.resolve(e.currentTarget)} />
      {showPopup && createPortal(
        <div ref={popupRef} className="cell-editor-popup"
             style={{ left: pos?.x ?? 0, top: pos?.y ?? 0,
                      visibility: pos ? undefined : "hidden" }}>
          {hasHint && <div className="cell-editor-hint">{hint}</div>}
          {titleRows.length > 0
            ? <AutocompletePopup rows={titleRows} selected={titleSel}
                                 onPick={pickTitle} />
            : values.length > 0 && (
              <div className="ac-popup" role="listbox" aria-label="Suggestions">
                {values.map((s, i) => (
                  <div key={s.value} role="option"
                       aria-selected={i === valueSelected}
                       className={"ac-row" + (i === valueSelected ? " selected" : "")}
                       onMouseDown={(e) => { e.preventDefault(); pickValue(s); }}>
                    {s.value}
                    <span className="cell-editor-count">{s.count}</span>
                  </div>
                ))}
              </div>
            )}
        </div>,
        document.body,
      )}
    </>
  );
}
