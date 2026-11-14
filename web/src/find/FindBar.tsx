// pattern: Imperative Shell
// Cmd-F / Cmd-G for the installed app, which has no browser find. Matches
// are painted with the CSS Custom Highlight API, so the DOM React owns is
// never wrapped or reselected.
import { type KeyboardEvent as ReactKeyboardEvent,
         type MouseEvent as ReactMouseEvent, useCallback, useEffect, useRef,
         useState } from "react";
import type { BlockUid } from "../api/brands";
import { parseBlockUid } from "../ids";
import { isModalOpen } from "../useModal";
import { clampIndex, findCommand, findMatches, firstAtOrBelow, revealDelta,
         stepIndex } from "./findMatches";
import { collectPageText, FIND_ROOTS_SELECTOR, matchRange } from "./pageText";

const STANDALONE = "(display-mode: standalone)";
const ALL = "pkm-find";
const CURRENT = "pkm-find-current";
const SCROLL_MARGIN = 16;

type Hits = { ranges: Range[]; index: number | null; scroll: boolean };
const NO_HITS: Hits = { ranges: [], index: null, scroll: false };

// A block's textarea unmounts when the find input takes focus, so the block
// is found again by uid within the pane it was in.
type ReturnTarget = {
  el: HTMLElement | null; uid: BlockUid | null; root: Element | null };

function searchRoots(): Element[] {
  return [...document.querySelectorAll(FIND_ROOTS_SELECTOR)];
}

// Body is watched so that a region mounting while the bar is open (the
// right sidebar) is searched. Changes elsewhere, the bar's own count among
// them, must not recount, or every recount would schedule the next.
function touchesRoots(record: MutationRecord): boolean {
  const { target } = record;
  const el = target instanceof Element ? target : target.parentElement;
  if (el?.closest(FIND_ROOTS_SELECTOR)) return true;
  return [...record.addedNodes, ...record.removedNodes].some((node) =>
    node instanceof Element && (node.matches(FIND_ROOTS_SELECTOR)
      || node.querySelector(FIND_ROOTS_SELECTOR) !== null));
}

function returnTargetFor(el: HTMLElement | null): ReturnTarget {
  const block = el instanceof HTMLTextAreaElement
    && el.matches(".block-input") ? el : null;
  return {
    el,
    uid: parseBlockUid(
      block?.closest("[data-uid]")?.getAttribute("data-uid") ?? ""),
    root: block?.closest(FIND_ROOTS_SELECTOR) ?? null,
  };
}

function scrollerOf(el: Element | null): Element | null {
  for (let n = el; n; n = n.parentElement) {
    const { overflowY } = getComputedStyle(n);
    if ((overflowY === "auto" || overflowY === "scroll")
        && n.scrollHeight > n.clientHeight) return n;
  }
  return null;
}

function reveal(range: Range, bar: HTMLElement | null): void {
  const scroller = scrollerOf(range.startContainer.parentElement);
  const view = scroller?.getBoundingClientRect()
    ?? { top: 0, bottom: window.innerHeight };
  const delta = revealDelta(range.getBoundingClientRect(), view,
    bar?.getBoundingClientRect() ?? null, SCROLL_MARGIN);
  if (delta === 0) return;
  (scroller ?? document.scrollingElement ?? document.documentElement)
    .scrollBy({ top: delta });
}

function* rangeTops(ranges: readonly Range[]): Generator<number> {
  for (const range of ranges) yield range.getBoundingClientRect().top;
}

function selectedText(el: HTMLElement | null): string {
  if (el instanceof HTMLTextAreaElement) {
    return el.value.slice(el.selectionStart, el.selectionEnd);
  }
  return window.getSelection()?.toString() ?? "";
}

function restoreFocus({ el, uid, root }: ReturnTarget): void {
  if (el?.isConnected) {
    el.focus();
    return;
  }
  if (uid === null || root === null) return;
  root.querySelector<HTMLElement>(`[data-uid="${uid}"] > .block-text`)
    ?.click();
}

export function FindBar(): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Hits>(NO_HITS);
  const inputRef = useRef<HTMLInputElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const openRef = useRef(false);
  const returnTo = useRef<ReturnTarget | null>(null);
  // A Cmd-G that opens the bar steps once the matches exist.
  const pendingStep = useRef<1 | -1 | null>(null);

  const begin = useCallback(() => {
    const active = document.activeElement;
    const el = active instanceof HTMLElement ? active : null;
    returnTo.current = returnTargetFor(el);
    const picked = selectedText(el);
    if (picked !== "" && !picked.includes("\n")) setQuery(picked);
    openRef.current = true;
    setOpen(true);
  }, []);

  const step = useCallback((dir: 1 | -1) => {
    setHits((h) => ({
      ...h, index: stepIndex(h.index, h.ranges.length, dir), scroll: true }));
  }, []);

  const close = useCallback(() => {
    openRef.current = false;
    setOpen(false);
    setHits(NO_HITS);
    const target = returnTo.current;
    returnTo.current = null;
    if (target) restoreFocus(target);
  }, []);

  // Escape is caught here, ahead of the page, so that it closes the bar
  // wherever focus is, as it closes the viewers. A block being edited
  // keeps its edit until the next Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && openRef.current && !isModalOpen()
          && !e.isComposing && e.keyCode !== 229) {
        e.preventDefault();
        e.stopPropagation();
        close();
        return;
      }
      const command = findCommand(e);
      if (command === null || isModalOpen()
          || !window.matchMedia(STANDALONE).matches) return;
      e.preventDefault();
      const dir = command === "next" ? 1 : command === "prev" ? -1 : null;
      if (!openRef.current) {
        pendingStep.current = dir;
        begin();
      } else if (dir !== null) {
        step(dir);
      } else {
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [begin, step, close]);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [open]);

  // Escape returns to where the user last was outside the bar, which may be
  // a block they went on to edit after opening it.
  useEffect(() => {
    if (!open) return;
    const onFocusIn = (e: FocusEvent) => {
      const { target } = e;
      if (!openRef.current || !(target instanceof HTMLElement)
          || target.closest(".find-bar")) return;
      returnTo.current = returnTargetFor(target);
    };
    document.addEventListener("focusin", onFocusIn);
    return () => document.removeEventListener("focusin", onFocusIn);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const recount = (fresh: boolean) => {
      const text = collectPageText(searchRoots());
      const ranges = findMatches(text.groups, query)
        .map((m) => matchRange(text, m));
      const dir = pendingStep.current;
      pendingStep.current = null;
      const start = !fresh ? null
        : dir !== null ? stepIndex(null, ranges.length, dir)
        : firstAtOrBelow(rangeTops(ranges), 0);
      setHits((h) => ({
        ranges,
        index: fresh ? start : clampIndex(h.index, ranges.length),
        scroll: fresh,
      }));
    };
    recount(true);
    let frame = 0;
    const observer = new MutationObserver((records) => {
      if (frame !== 0 || !records.some(touchesRoots)) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        recount(false);
      });
    });
    observer.observe(document.body,
      { subtree: true, childList: true, characterData: true });
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [open, query]);

  useEffect(() => {
    if (!open) return;
    // Spreading the ranges into the constructor throws in Safari past about
    // 64k matches, so they are added one at a time.
    const all = new Highlight();
    for (const range of hits.ranges) all.add(range);
    CSS.highlights.set(ALL, all);
    const current = hits.index === null ? null : hits.ranges[hits.index];
    if (current) {
      const mark = new Highlight();
      mark.add(current);
      mark.priority = 1;
      CSS.highlights.set(CURRENT, mark);
      if (hits.scroll) reveal(current, barRef.current);
    }
    return () => {
      CSS.highlights.delete(ALL);
      CSS.highlights.delete(CURRENT);
    };
  }, [open, hits]);

  if (!open) return null;

  // Enter on a button is left to the button's own click.
  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === "Enter") {
      e.preventDefault();
      step(e.shiftKey ? -1 : 1);
    }
  };
  // Safari blurs the input on a button press and focuses nothing, which
  // would leave Enter without a handler.
  const keepFocus = (e: ReactMouseEvent) => e.preventDefault();

  const total = hits.ranges.length;
  const status = total > 0 && hits.index !== null
    ? `${hits.index + 1} of ${total}`
    : query === "" ? "" : "No matches";

  return (
    <div ref={barRef} className="find-bar" role="search">
      <input ref={inputRef} className="input-control find-bar-input"
             type="text" aria-label="Find on page" value={query}
             autoComplete="off" spellCheck={false} onKeyDown={onKeyDown}
             onChange={(e) => setQuery(e.target.value)} />
      <span className="find-bar-count" aria-live="polite">{status}</span>
      <button type="button" className="btn-secondary btn-compact"
              aria-label="Previous match" onMouseDown={keepFocus}
              onClick={() => step(-1)}>↑</button>
      <button type="button" className="btn-secondary btn-compact"
              aria-label="Next match" onMouseDown={keepFocus}
              onClick={() => step(1)}>↓</button>
      <button type="button" className="btn-secondary btn-compact"
              aria-label="Close find" onMouseDown={keepFocus}
              onClick={close}>✕</button>
    </div>
  );
}
