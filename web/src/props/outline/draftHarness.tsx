// pattern: Imperative Shell
// Runs a draft example against the real editor: useOutline and
// EditableBlockTree rendered in jsdom over a sync fake, with fake timers for
// the debounce. Each command is a DOM event or an outline/session call; after
// it, effects settle and the editor is checked against draftModel.ts.
import { act, cleanup, createEvent, fireEvent, render,
         screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { vi } from "vitest";
import type { CanonicalTitle } from "../../api/brands";
import type { BlockOp } from "../../api/ops";
import type { BlockNode } from "../../api/payloads";
import { EditableBlockTree } from "../../components/EditableBlockTree";
import type { OutlineHandlers } from "../../outline/handlers";
import { peekOutlineSession } from "../../outline/outlineSessions";
import { resetHistory } from "../../outline/undoManager";
import { imeClock } from "../../outline/useBlockDraft";
import { useOutline, type Outline } from "../../outline/useOutline";
import { ROUTER_FUTURE_FLAGS } from "../../router";
import { SyncContext } from "../../sync/SyncProvider";
import { block, canonicalTitleOf, clientIdOf, makeSync, orderIdxOf,
         uidOf, confirmYes } from "../../test-helpers";
import { afterEdit, afterFlush, afterLanded, displayed, flushOpMatches,
         flushSend, imeOwns, initialModel, serverApply, shown,
         type DraftCommand, type DraftExample,
         type DraftModel } from "./draftModel";

const UID = uidOf("tuid-draft");
const FILE = { path: "Papers/notes.zip", href: "/api/local/Papers/notes.zip" };
const ATTRIBUTE = "Local copy:: [notes.zip]";

/** Where a teeth check swaps in a broken editor: the handlers the tree's
 * textarea sees. `treeText` reads the block's text in the outline now. */
export interface DraftSeam {
  wrapHandlers(h: OutlineHandlers, treeText: () => string): OutlineHandlers;
}
export const REAL_SEAM: DraftSeam = { wrapHandlers: (h) => h };

export interface DraftRun {
  problems: string[];
  /** One entry per path reached, for the suite's tally. */
  labels: string[];
}

let pageCount = 0;

function Page({ title, initial, seam, outlineRef }: {
  title: CanonicalTitle; initial: BlockNode[]; seam: DraftSeam;
  outlineRef: { current: Outline | null };
}) {
  const o = useOutline(title, initial, confirmYes);
  outlineRef.current = o;
  const treeText = () =>
    outlineRef.current?.blocks.find((b) => b.uid === UID)?.text ?? "";
  return <EditableBlockTree blocks={o.blocks} focus={o.focus}
                            selection={o.selection}
                            handlers={seam.wrapHandlers(o.handlers, treeText)}
                            readOnly={o.readOnly} />;
}

function textarea(): HTMLTextAreaElement | null {
  return screen.queryByRole("textbox") as HTMLTextAreaElement | null;
}

function blockText(): HTMLElement {
  return screen.getAllByText(
    (_, el) => el?.classList.contains("block-text") ?? false)[0];
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
}

export async function runDraftExample(example: DraftExample,
                                      seam: DraftSeam = REAL_SEAM,
): Promise<DraftRun> {
  vi.useFakeTimers();
  // The IME window reads the faked Date, the clock ticks and gapMs move.
  const clock = vi.spyOn(imeClock, "now").mockImplementation(() => Date.now());
  vi.stubGlobal("fetch", vi.fn(async () =>
    new Response(JSON.stringify({ detail: "not found" }), { status: 404 })));
  resetHistory();
  const title = canonicalTitleOf(`Draft Props ${++pageCount}`);
  const sync = makeSync();
  const outlineRef: { current: Outline | null } = { current: null };
  const labels: string[] = [];
  const problems: string[] = [];
  try {
    render(
      <SyncContext.Provider value={sync}>
        <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
          <Page title={title} seam={seam} outlineRef={outlineRef}
                initial={[block(UID, example.start,
                                { order_idx: orderIdxOf(0) })]} />
        </MemoryRouter>
      </SyncContext.Provider>);
    fireEvent.click(blockText());
    await settle();
    let model = initialModel(example.start);
    for (const [i, command] of example.commands.entries()) {
      const mark = sync.sent.length;
      const step = await apply(command, model, outlineRef, title, sync.emit,
                               labels);
      await settle();
      const sent = sync.sent.slice(mark);
      const found = check(step, sent, outlineRef.current!, labels);
      model = found.model;
      if (found.problems.length > 0) {
        problems.push(...found.problems.map(
          (p) => `step ${i} ${JSON.stringify(command)}: ${p}`));
        break;
      }
      if (step.then === "split") break;
    }
  } finally {
    cleanup();
    clock.mockRestore();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
  return { problems, labels };
}

/** WebKit stamps a trusted keydown on another clock from the events it
 * raises itself, compositionend among them; so do these. */
const KEYDOWN_CLOCK_BASE = 815_684_366_637;

function keyDown(ta: HTMLTextAreaElement, init: KeyboardEventInit): void {
  const ev = createEvent.keyDown(ta, init);
  Object.defineProperty(ev, "timeStamp",
                        { value: KEYDOWN_CLOCK_BASE + performance.now() });
  fireEvent(ta, ev);
}

/** What a command did to the model, and what it should have sent. */
interface Step {
  /** The model once the step's flush (if any) was taken, before any send. */
  model: DraftModel;
  /** The draft flush this step must send first, or null. */
  flush: { text: string; base: string } | null;
  conflictAllowed: boolean;
  /** What else the step sends after the flush. A split ends the example:
   * the model is of one block. */
  then: "nothing" | "splice" | "undo" | "split";
  /** For an undo: the text the undone batch's block had before it. */
  undoneTo: string | null;
  /** A keydown the IME owns: it must send and split nothing. */
  imeOwned?: boolean;
  /** An Escape the IME does not own: the block must leave edit mode. */
  escapes?: boolean;
}

function flushStep(model: DraftModel, labels: string[], then: Step["then"],
                   undoneTo: string | null = null): Step {
  const send = flushSend(model);
  if (model.pending !== null && send === null) labels.push("flush-sends-nothing");
  if (model.pending !== null && model.pending.text === model.pending.base) {
    labels.push("erase-to-base");
  }
  return { model: afterFlush(model), flush: send,
           conflictAllowed: model.landedUnderDraft, then, undoneTo };
}

async function apply(command: DraftCommand, model: DraftModel,
                     outlineRef: { current: Outline | null },
                     title: CanonicalTitle,
                     emit: ReturnType<typeof makeSync>["emit"],
                     labels: string[]): Promise<Step> {
  const idle: Step = { model, flush: null, conflictAllowed: false,
                       then: "nothing", undoneTo: null };
  const ta = textarea();
  // Only a keydown consumes the composition just ended.
  const keydown = (): DraftModel => ({ ...model, endedAt: null });
  switch (command.k) {
    case "type":
    case "erase": {
      if (ta === null || (command.k === "erase" && ta.value === "")) {
        labels.push("skip");
        return idle;
      }
      const value = command.k === "type" ? ta.value + command.ch
                                         : ta.value.slice(0, -1);
      if (model.pending === null && model.display !== model.server) {
        labels.push("typed-over-held-text");
      }
      act(() => {
        fireEvent.change(ta, { target: { value } });
        ta.setSelectionRange(value.length, value.length);
      });
      return { ...idle, model: afterEdit(model, value) };
    }
    case "tick": {
      act(() => { vi.advanceTimersByTime(command.ms); });
      const ticked = { ...model, now: model.now + command.ms };
      if (ticked.due === null || ticked.now < ticked.due) {
        return { ...idle, model: ticked };
      }
      labels.push("debounce-flush");
      return flushStep(ticked, labels, "nothing");
    }
    case "remote":
    case "replay": {
      if (model.pending !== null) labels.push(`${command.k}-under-draft`);
      if (model.composing) labels.push(`${command.k}-while-composing`);
      if (command.k === "remote") {
        act(() => emit({
          client_id: clientIdOf("other"), ts: 1,
          ops: [{ op: "update_text", uid: UID, text: command.text }],
        }));
      } else {
        const handle = peekOutlineSession(title)!;
        try {
          const current = outlineRef.current!.blocks;
          act(() => {
            const token = handle.beginAuthoritativeRead();
            handle.receiveAuthoritative(token, current.map((b) =>
              b.uid === UID ? { ...b, text: command.text } : b));
          });
        } finally {
          handle.release();
        }
      }
      return { ...idle, model: afterLanded(model, command.text) };
    }
    case "splice": {
      if (ta !== null && model.pending !== null) {
        labels.push(flushSend(model) !== null ? "flush-then-splice"
                                              : "splice-over-unsent-draft");
      }
      act(() => {
        outlineRef.current!.handlers.onLinkLocalFile(UID, command.at, FILE);
      });
      return flushStep(model, labels, "splice");
    }
    case "undo": {
      if (ta === null) {
        labels.push("skip");
        return idle;
      }
      if (imeOwns(model, "plain")) {
        labels.push("undo-while-composing");
        act(() => { keyDown(ta, { key: "z", metaKey: true }); });
        return { ...idle, model: keydown(), imeOwned: true };
      }
      if (model.pending !== null) labels.push("undo-over-draft");
      act(() => { keyDown(ta, { key: "z", metaKey: true }); });
      const step = flushStep(keydown(), labels, "undo");
      const undo = [...step.model.undo];
      if (step.flush !== null) undo.push(model.server);
      const undoneTo = undo.pop() ?? null;
      return { ...step, model: { ...step.model, undo }, undoneTo };
    }
    case "blur": {
      if (ta === null) {
        labels.push("skip");
        return idle;
      }
      // A browser ends the composition before the blur.
      if (model.composing) act(() => { fireEvent.compositionEnd(ta); });
      act(() => { fireEvent.blur(ta); });
      return flushStep({ ...model, composing: false, endedAt: null }, labels,
                       "nothing");
    }
    case "refocus": {
      if (ta !== null) {
        labels.push("skip");
        return idle;
      }
      act(() => { fireEvent.click(blockText()); });
      return idle;
    }
    case "compose-start": {
      if (ta === null || model.composing) {
        labels.push("skip");
        return idle;
      }
      act(() => { fireEvent.compositionStart(ta); });
      return { ...idle, model: { ...model, composing: true } };
    }
    case "compose-end": {
      if (ta === null || !model.composing) {
        labels.push("skip");
        return idle;
      }
      labels.push("compose-end");
      if (model.display !== shown(model)) labels.push("compose-end-adopts");
      act(() => { fireEvent.compositionEnd(ta); });
      if (command.key === null) {
        return { ...idle, model: { ...model, composing: false,
                                   endedAt: model.now } };
      }
      // The IME clock moves past the timers' (Date, not the fake timer
      // queue), so the model dates the end that much earlier.
      if (command.gapMs > 0) vi.setSystemTime(Date.now() + command.gapMs);
      const ended = { ...model, composing: false,
                      endedAt: model.now - command.gapMs };
      return apply(command.key, { ...ended, display: shown(ended) },
                   outlineRef, title, emit, labels);
    }
    case "key": {
      if (ta === null) {
        labels.push("skip");
        return idle;
      }
      const { key, ime } = command;
      const keyCode = ime !== "plain" ? 229 : key === "Enter" ? 13 : 27;
      const owned = imeOwns(model, ime);
      if (owned) {
        labels.push(model.composing ? `ime-${key}-composing`
          : ime === "composing" ? `ime-${key}-flagged`
          : `ime-${key}-after-end`);
      } else if (ime === "229") {
        labels.push(model.endedAt !== null ? `${key}-229-late`
                                           : `${key}-229-unowned`);
      } else if (model.endedAt !== null) {
        labels.push(`${key}-right-after-end`);
      }
      act(() => {
        keyDown(ta, { key, keyCode, isComposing: ime === "composing" });
      });
      if (owned) return { ...idle, model: keydown(), imeOwned: true };
      if (key === "Escape") {
        return { ...flushStep(keydown(), labels, "nothing"), escapes: true };
      }
      labels.push("enter-splits");
      return { ...idle, model: keydown(), then: "split" };
    }
  }
}

/** Check one step's sends and the editor after it; returns the model with
 * the sends applied to its server. */
function check(step: Step, sent: BlockOp[][], outline: Outline,
               labels: string[]): { model: DraftModel; problems: string[] } {
  const problems: string[] = [];
  let model = step.model;
  const before = model.server;
  const count = outline.blocks.length;
  const ops = sent.flat();
  if (step.then === "split") {
    if (count !== 2) {
      problems.push(`split: an Enter the IME does not own left ${count} `
        + "block(s), expected 2");
    }
    return { model, problems };
  }
  if (step.imeOwned && (count !== 1 || ops.length > 0)) {
    problems.push(`ime: a keydown the IME owns left ${count} block(s) and `
      + `sent ${JSON.stringify(ops)}`);
    return { model, problems };
  }
  if (count !== 1) {
    problems.push(`the outline holds ${count} blocks, expected 1`);
  }
  if (step.escapes && textarea() !== null) {
    problems.push("escape: an Escape the IME does not own left the block "
      + "in edit mode");
    return { model, problems };
  }
  let next = 0;
  const take = (): BlockOp | undefined => ops[next++];
  const toServer = (op: BlockOp, allowed: boolean) => {
    const r = serverApply(model, op, allowed);
    model = r.model;
    if (r.conflict) labels.push("conflict");
    if (r.problem !== null) problems.push(r.problem);
  };
  if (step.flush !== null) {
    const op = take();
    const wrong = flushOpMatches(op, step.flush);
    if (wrong !== null) problems.push(wrong);
    else toServer(op!, step.conflictAllowed);
  }
  if (step.then === "splice") {
    const op = take();
    if (op?.op !== "update_text" || !op.text.includes(ATTRIBUTE)) {
      problems.push(`splice: expected an update_text holding the attribute, `
        + `got ${JSON.stringify(op ?? null)}`);
    } else {
      toServer(op, false);
      model = { ...model, undo: [...model.undo, before] };
    }
  } else if (step.then === "nothing" && step.flush !== null) {
    model = { ...model, undo: [...model.undo, before] };
  } else if (step.then === "undo" && step.undoneTo !== null) {
    labels.push("undo-applied");
    while (next < ops.length) toServer(take()!, false);
    if (model.server !== step.undoneTo) {
      problems.push(`undo: expected the block back at `
        + `${JSON.stringify(step.undoneTo)}, the server holds `
        + `${JSON.stringify(model.server)}`);
    }
  }
  if (next < ops.length) {
    problems.push(`unexpected sends: ${JSON.stringify(ops.slice(next))}`);
  }
  const tree = outline.blocks.find((b) => b.uid === UID)?.text;
  if (tree !== model.server) {
    problems.push(`tree: holds ${JSON.stringify(tree)}, the server `
      + `${JSON.stringify(model.server)}`);
  }
  const pending = outline.handlers.pendingDraft(UID) !== null;
  if (pending !== (model.pending !== null)) {
    problems.push(`pending: the outline ${pending ? "holds" : "holds no"} `
      + `draft, the model ${model.pending ? "holds one" : "none"}`);
  }
  const ta = textarea();
  const expected = displayed(model);
  if (ta !== null && ta.value !== expected) {
    problems.push(`adopt: the textarea shows ${JSON.stringify(ta.value)}, `
      + `expected ${JSON.stringify(expected)} (`
      + `${model.pending ? "the pending draft"
        : model.composing ? "the text before the composition"
        : "the tree's text"})`);
  }
  if (model.composing && ta === null) {
    problems.push("ime: the textarea went away mid-composition");
  }
  return { model: { ...model, display: expected }, problems };
}
