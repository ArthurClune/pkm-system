// pattern: Imperative Shell
// The one live textarea: the focused block's input surface. It wires three
// engine-owned pieces together and executes what they decide —
// outline/useBlockDraft.ts (the draft value, IME, adoption, caret placement),
// outline/useAutocomplete.ts (the completion popup's state), and
// outline/keyboardPolicy.ts (what a keystroke means) — and adds the surfaces
// that only exist while a block is focused: the completion popup and its
// picks (slash commands, /upload, /date), the inline date picker, paste and
// drop, and Ctrl-O ref navigation. Every semantic mutation goes out through
// the OutlineHandlers port; nothing here touches the block tree (pkm-64bq).
import { useContext, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { apiPost } from "../api/typedClient";
import type { BlockNode } from "../api/payloads";
import { SidebarContext } from "../contexts";
import { applyCompletion, holdsDraftFlush } from "../outline/autocomplete";
import { measureCaretDisplayLine } from "../outline/caretDisplayLine";
import type { OutlineHandlers } from "../outline/handlers";
import { type TextSelection } from "../outline/keyEdits";
import { decideEditorKey } from "../outline/keyboardPolicy";
import { isOutlinePaste, isOutlinePasteChord } from "../outline/paste";
import { applySlashCommand, matchSlashCommands,
         resolveHeading } from "../outline/slashCommands";
import { useAutocomplete } from "../outline/useAutocomplete";
import { useBlockDraft } from "../outline/useBlockDraft";
import { pagePath } from "../paths";
import { titleForDate } from "../replica/daily";
import { AutocompletePopup, buildRows, useTitleOptions,
         type AcRow } from "./AutocompletePopup";
import { DatePickerPopup } from "./DatePickerPopup";

export function BlockInput({ node, cursor, handlers, readOnly,
                             onRequestUpload }: {
  node: BlockNode; cursor: number;
  handlers: OutlineHandlers; readOnly: boolean;
  onRequestUpload: (uid: string, at: number) => void;
}) {
  const headingClass =
    node.heading === 1 ? " heading-1" :
    node.heading === 2 ? " heading-2" :
    node.heading === 3 ? " heading-3" : "";
  // Insertion offset for the /date picker; null = closed. The offset is
  // where the stripped "/" trigger sat. Every path that replaces the draft
  // closes the picker (onChange / applyKeyEdit / the draft's onAdopt below),
  // so the offset can't go stale; pickDate still clamps as a backstop.
  const [datePickerAt, setDatePickerAt] = useState<number | null>(null);
  // A draft typed with the caret inside an open [[ ref / #tag token is
  // flush-held (pkm-xlah): the debounced autosave would turn the half-typed
  // title into a page. The plain two-arg call is kept when not held.
  const draft = useBlockDraft({
    text: node.text,
    cursor,
    onEdit: (text, holdFlush) => {
      if (holdFlush) handlers.onDraftChange(node.uid, text, true);
      else handlers.onDraftChange(node.uid, text);
    },
    onAdopt: () => setDatePickerAt(null), // adopted text invalidates the offset
  });
  // Shared with the phone Composer (pkm-noow): the completion context and the
  // caret a pick splices at are re-derived from the live textarea selection,
  // so a click or a selection-only caret move (neither fires an input event)
  // can't leave a completion pointing at where the caret used to be.
  const ac = useAutocomplete();
  const navigate = useNavigate();
  const { openInSidebar } = useContext(SidebarContext);
  // Armed by a Shift-Cmd-V keydown, consumed by the paste event that follows
  // (pkm-fwa2): a ClipboardEvent carries no modifier state, so this is how
  // the paste handler knows the user asked for the outline split. Any other
  // keydown clears it, so a stale arm (chord pressed but no paste delivered)
  // can't hijack a later plain Cmd-V.
  const outlinePasteArmedRef = useRef(false);
  // The "/" trigger is served from the static command list, not the titles
  // API, so only fetch titles for ref/tag contexts.
  const options = useTitleOptions(
    ac.ctx && ac.ctx.kind !== "command" ? ac.ctx.query : null);
  const acRows: AcRow[] = !ac.ctx ? [] : ac.ctx.kind === "command"
    ? matchSlashCommands(ac.ctx.query).map((c) => ({ title: c.label, isNew: false, command: c.name }))
    : buildRows(options, ac.ctx.query);

  /** Replace the draft with `text`, placing a collapsed caret at `cursorPos`.
   * Used by the completion/command paths, which have already decided the new
   * text and never leave the caret inside a half-typed token. */
  const setText = (text: string, cursorPos: number) => {
    draft.replace(text, cursorPos, cursorPos, false);
  };

  // Apply a bracket/link key edit. Unlike a normal keystroke this bypasses
  // onChange (we preventDefault), so we re-derive the autocomplete context here
  // — that's what lets typing "[" twice open the [[ page-link popup.
  const applyKeyEdit = (r: TextSelection) => {
    setDatePickerAt(null);
    const ctx = ac.onEdit(r.text, r.selStart);
    draft.replace(r.text, r.selStart, r.selEnd, holdsDraftFlush(ctx));
  };

  // Ctrl-O / Ctrl-Shift-O over a [[page reference]] (pkm-a1e4): the target
  // page may not exist server-side yet. A ref only gets-or-created when its
  // block text actually flushes (ops_apply.py, mirroring every ref in the
  // committed text) -- while the caret still sits inside the [[...]] token
  // the draft flush is held (pkm-xlah), so a brand-new reference typed this
  // session has no row at all. POST /api/pages is idempotent (creating an
  // existing page just returns it, routes_pages.create_page) so it's safe
  // to call unconditionally before navigating/opening, the same
  // create-then-go sequence SearchBar's "Create page" row uses. Best-effort:
  // if creation fails (e.g. offline), still navigate/open as before -- the
  // destination view surfaces its own error if the page truly isn't there.
  //
  // The held draft is flushed FIRST (pkm-hhbc, data loss): navigating unmounts
  // this tree and React delivers no blur for a removed node, so the only
  // other commit point never runs and the typed text -- including the ref we
  // are navigating to -- was lost. Flushing before POST /api/pages also keeps
  // the ref row a product of the normal ops path instead of racing it.
  const ensureRefPageThenOpen = async (title: string, sidebar: boolean) => {
    handlers.onFlushDraft();
    try {
      await apiPost("/api/pages", { body: { title } });
    } catch {
      // fall through regardless
    }
    if (sidebar) openInSidebar(title);
    else navigate(pagePath(title));
  };

  const pick = (row: AcRow) => {
    const target = ac.resolve(draft.ref.current);
    if (!target) return; // caret has moved off the token; resolve closed it
    const { ctx, caret, text } = target;
    // "/upload": strip the trigger, then open the tree-owned file picker.
    // handlers.onFiles splices the uploaded asset's markdown in once the user
    // has chosen files; the input outlives this component (pkm-gbsb) because
    // choosing a file blurs (and so unmounts) BlockInput.
    if (row.command === "upload") {
      const at = ctx.start - 1; // where the "/" was
      ac.close();
      setText(text.slice(0, at) + text.slice(caret), at);
      onRequestUpload(node.uid, at);
      return;
    }
    // "/date": strip the trigger like /upload, but open the inline
    // focus-preserving picker instead of a native dialog — the textarea
    // keeps focus (the picker is mouse-down-only), so the eventual
    // insertion goes through the normal setText draft path.
    if (row.command === "date") {
      const at = ctx.start - 1; // where the "/" was
      ac.close();
      setText(text.slice(0, at) + text.slice(caret), at);
      setDatePickerAt(at);
      return;
    }
    const applied = row.command
      ? applySlashCommand(text, caret, ctx, row.command, new Date())
      : applyCompletion(text, caret, ctx, row.title);
    ac.close();
    setText(applied.text, applied.cursor);
    // Heading commands (/h1 /h2 /h3 /normal) aren't text transforms: the
    // trigger is stripped above like any other command, but the heading
    // field itself is set via a dedicated op, dispatched here against the
    // block's current heading so picking the active one toggles it off.
    if (row.command) {
      const heading = resolveHeading(row.command, node.heading);
      if (heading !== undefined) handlers.onSetHeading(node.uid, heading);
    }
  };

  const pickDate = (d: Date) => {
    if (datePickerAt === null) return;
    const at = Math.min(datePickerAt, draft.text.length);
    setDatePickerAt(null);
    const link = `[[${titleForDate(d)}]]`;
    setText(draft.text.slice(0, at) + link + draft.text.slice(at),
            at + link.length);
  };

  const onChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setDatePickerAt(null); // any typed edit invalidates the stored offset
    const value = e.target.value;
    const pos = e.target.selectionStart ?? value.length;
    const ctx = ac.onEdit(value, pos);
    draft.typed(value, holdsDraftFlush(ctx));
  };

  // The keydown POLICY lives in the functional core (keyboardPolicy.ts); this
  // shell only reads the live DOM/autocomplete state, then executes the
  // returned semantic decision (preventDefault, blur, navigation, edits).
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget;
    // Arm the outline split on Shift-Cmd-V, clear it on anything else. No
    // preventDefault: the browser's own paste must still fire so onPaste
    // below receives the clipboard.
    outlinePasteArmedRef.current = isOutlinePasteChord(e);
    // Display-line measurement is real layout work, so it's only done for
    // the plain (unmodified) arrow that would actually consult it (pkm-2867)
    // — never for the Shift/Meta/Ctrl chords, which have their own logic,
    // and never for any other key. ArrowUp only needs "first" (measured at
    // selStart, matching the core's own up-check); ArrowDown only needs
    // "last" (at selEnd) — never both, so only one mirror is ever built.
    const plain = !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey;
    const caretOnFirstDisplayLine = plain && e.key === "ArrowUp"
      ? measureCaretDisplayLine(el, el.selectionStart)?.first : undefined;
    const caretOnLastDisplayLine = plain && e.key === "ArrowDown"
      ? measureCaretDisplayLine(el, el.selectionEnd)?.last : undefined;
    // The /date picker owns Escape while open; everything else falls
    // through to the normal policy (typing closes the picker via onChange).
    if (datePickerAt !== null && e.key === "Escape") {
      e.preventDefault();
      setDatePickerAt(null);
      return;
    }
    // A popup the caret has moved away from must not claim the key: Enter
    // stays a split, Tab stays an indent (pkm-noow). resolve() drops the
    // stale context, so the policy is told the popup is closed.
    const acLive = ac.resolve(el) !== null;
    const decision = decideEditorKey({
      key: e.key, code: e.code,
      metaKey: e.metaKey, ctrlKey: e.ctrlKey, altKey: e.altKey,
      shiftKey: e.shiftKey,
      selStart: el.selectionStart, selEnd: el.selectionEnd,
      draft: draft.text, readOnly,
      acRowsLength: acLive ? acRows.length : 0, acSelected: ac.selected,
      caretOnFirstDisplayLine, caretOnLastDisplayLine,
    });
    switch (decision.type) {
      case "none":
        return;
      case "blur":
        el.blur();
        return;
      case "ac-move":
        e.preventDefault();
        ac.setSelected(decision.selected);
        return;
      case "ac-pick":
        e.preventDefault();
        pick(acRows[ac.selected]);
        return;
      case "ac-close":
        e.preventDefault();
        ac.close();
        return;
      case "navigate-ref":
        e.preventDefault();
        void ensureRefPageThenOpen(decision.title, decision.sidebar);
        return;
      case "start-block-selection":
        e.preventDefault();
        handlers.onStartBlockSelection(node.uid, decision.dir);
        return;
      case "select-to-block-edge":
        // Ctrl+Cmd+Left/Right (pkm-am54): the native binding stops at the
        // display line of a wrapped block; we select to the block boundary.
        e.preventDefault();
        if (decision.edge === "start") {
          el.setSelectionRange(0, el.selectionEnd, "backward");
        } else {
          el.setSelectionRange(el.selectionStart, el.value.length, "forward");
        }
        return;
      case "select-range":
        // Shift+Cmd+Left/Right (pkm-jgtn): line-wise selection over logical
        // lines; the policy computed the exact range from the draft.
        e.preventDefault();
        el.setSelectionRange(decision.selStart, decision.selEnd,
                             decision.direction);
        return;
      case "select-whole-block":
        e.preventDefault();
        handlers.onSelectBlock(node.uid);
        return;
      case "set-heading":
        e.preventDefault();
        handlers.onSetHeading(node.uid, decision.heading);
        return;
      case "key-edit":
        e.preventDefault();
        applyKeyEdit(decision.edit);
        return;
      case "split":
        e.preventDefault();
        handlers.onSplit(node.uid, decision.cursor);
        return;
      case "indent":
        e.preventDefault();
        handlers.onIndent(node.uid);
        return;
      case "outdent":
        e.preventDefault();
        handlers.onOutdent(node.uid);
        return;
      case "move-subtree-up":
        // Shift-Cmd-Arrow is a macOS text-selection key and must not extend
        // the textarea's native selection.
        e.preventDefault();
        handlers.onMoveSubtreeUp(node.uid);
        return;
      case "move-subtree-down":
        e.preventDefault();
        handlers.onMoveSubtreeDown(node.uid);
        return;
      case "backspace-at-start":
        e.preventDefault();
        handlers.onBackspaceAtStart(node.uid);
        return;
      case "arrow":
        e.preventDefault();
        handlers.onArrow(node.uid, decision.dir);
        return;
      case "undo":
        e.preventDefault(); // kill native textarea undo
        handlers.onUndo();
        return;
      case "redo":
        e.preventDefault();
        handlers.onRedo();
        return;
      default: {
        const exhaustive: never = decision;
        return exhaustive;
      }
    }
  };

  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const armed = outlinePasteArmedRef.current;
    outlinePasteArmedRef.current = false; // one arm serves exactly one paste
    if (readOnly) return;
    const files = Array.from(e.clipboardData.files);
    if (files.length > 0) {
      e.preventDefault();
      handlers.onFiles(node.uid, e.currentTarget.selectionStart, files);
      return;
    }
    const text = e.clipboardData.getData("text/plain");
    // Plain paste is always native (pkm-fwa2); the split needs both the
    // Shift-Cmd-V arm and a clipboard with actual structure to splice into.
    if (!armed || !isOutlinePaste(text)) return;
    e.preventDefault();
    handlers.onPasteOutline(node.uid, e.currentTarget.selectionStart,
                            e.currentTarget.selectionEnd, text);
  };

  const onDrop = (e: React.DragEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0 || readOnly) return;
    e.preventDefault();
    handlers.onFiles(node.uid, e.currentTarget.selectionStart, files);
  };

  return (
    <div className="block-input-wrap">
      <textarea ref={draft.ref} className={`block-input${headingClass}`} rows={1}
                value={draft.text} readOnly={readOnly}
                onChange={onChange} onKeyDown={onKeyDown}
                onClick={(e) => ac.resolve(e.currentTarget)}
                onBlur={() => handlers.onBlurBlock(node.uid)}
                onPaste={onPaste} onDrop={onDrop}
                onCompositionStart={draft.onCompositionStart}
                onCompositionEnd={draft.onCompositionEnd} />
      {!readOnly && (
        <AutocompletePopup rows={acRows} selected={ac.selected} onPick={pick} />
      )}
      {!readOnly && datePickerAt !== null && (
        <DatePickerPopup initial={new Date()} onPick={pickDate} />
      )}
    </div>
  );
}
