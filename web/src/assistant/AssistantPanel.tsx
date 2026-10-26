// pattern: Imperative Shell
// Floating assistant chat panel (bottom-right overlay; not a route).

import { useEffect, useRef, useState, type Ref, type RefObject } from "react";
import { BlockRefProvider } from "../components/BlockRefProvider";
import { InlineSegments } from "../components/InlineSegments";
import { UntrustedContentContext } from "../contexts";
import { tokenizeBlock } from "../grammar/tokenize";
import { confirmHint, placeOf, type MarkerState } from "./confirmHint";
import { elapsedLabel } from "./elapsed";
import { stripCaretBlockRefs } from "./normalizeRefs";
import { useAssistant, type PendingConfirm } from "./useAssistant";
import {
  formatTarget, quoteValue, type CurrentBlock, type PreviewOp, type WritePreview,
} from "./writePreview";

// Each content value shows this many code points until [show] reveals the
// rest, which the server always sends; targets are never clipped, so Allow
// never sits below a hidden destination.
const CONTENT_CLIP = 280;
// Allow stays disabled this long after a card mounts, so a double-click aimed
// at the control the card replaced cannot land on it. Deny is live at once.
const ALLOW_ARM_MS = 600;

function ContentValue({ name, text, total }: {
  name: string;
  text: string;
  total: number;
}) {
  const [expanded, setExpanded] = useState(false);
  // total is the server's count of code points, so the clip counts them too,
  // which also keeps it from splitting a surrogate pair
  const points = [...text];
  const clipped = points.length > CONTENT_CLIP;
  const shown = clipped && !expanded ? points.slice(0, CONTENT_CLIP) : points;
  return (
    <div className="assistant-confirm-content">
      <span className="assistant-confirm-key">{name}</span>{": "}
      {clipped && <span className="assistant-confirm-length">({total} chars)</span>}
      {clipped && (
        <>
          {" "}
          <button
            type="button"
            className="assistant-preview-toggle"
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? "[hide]" : "[show]"}
          </button>
        </>
      )}
      {/* the ellipsis sits outside the closing quote: it is the card's mark,
        * not part of the value */}
      <bdi className="assistant-confirm-value assistant-confirm-text" dir="ltr">
        {quoteValue(shown.join(""))}{shown.length < total ? "…" : ""}
      </bdi>
    </div>
  );
}

const formatCount = (n: number) => n.toLocaleString("en-US");

// The block a write replaces, moves or deletes, as the server read it when
// it built the card. A move's own `page` target is where the block goes, so
// the page it is on now is labelled apart from it.
function CurrentRows({ current, moving }: {
  current: CurrentBlock;
  moving: boolean;
}) {
  if (current.state !== "found") {
    return (
      <div className="assistant-confirm-current">
        <span className="assistant-confirm-key">current text</span>{": "}
        {current.state === "missing" ? "no block has this uid" : (
          <>
            {`none yet (write ${current.write} above creates it as `}
            <bdi className="assistant-confirm-value" dir="ltr">
              {quoteValue(current.alias, false)}
            </bdi>
            {")"}
          </>
        )}
      </div>
    );
  }
  const { page_title, excerpt, text_length, descendants } = current;
  // text_length counts code points, so the excerpt's share does too
  const shown = [...excerpt].length;
  const clipped = shown < text_length;
  return (
    <>
      <div className="assistant-confirm-current">
        <span className="assistant-confirm-key">
          {moving ? "currently on page" : "current page"}
        </span>{": "}
        <bdi className="assistant-confirm-value" dir="ltr">
          {quoteValue(page_title, false)}
        </bdi>
      </div>
      <div className="assistant-confirm-current">
        <span className="assistant-confirm-key">current text</span>{": "}
        {clipped && (
          <span className="assistant-confirm-length">
            {`(first ${formatCount(shown)} of ${formatCount(text_length)} characters)`}
          </span>
        )}
        {/* the ellipsis sits outside the closing quote, as on content */}
        <bdi className="assistant-confirm-value assistant-confirm-text" dir="ltr">
          {quoteValue(excerpt)}{clipped ? "…" : ""}
        </bdi>
        {descendants !== null && descendants > 0 && (
          <div className="assistant-confirm-subtree">
            {`and ${formatCount(descendants)} ${descendants === 1 ? "block" : "blocks"} under it`}
          </div>
        )}
      </div>
    </>
  );
}

function targetLabel(op: PreviewOp, key: string): string {
  return op.action === "move block" && key === "page" ? "to page" : key;
}

// The ops scroll inside a region of their own, itself inside the scrolling
// transcript, so a short window can hide the heading or a target while Allow
// shows. Allow therefore also waits until a marker before the heading and one
// after the last op have each been in view, as reported against the viewport,
// which clips through every scrolling ancestor. With no IntersectionObserver
// Allow never arms; Deny still works. Until then a hint says which way the
// unseen marker lies.
function PreviewOps({ preview, endRef }: {
  preview: WritePreview;
  endRef: Ref<HTMLDivElement>;
}) {
  return (
    // focusable so a keyboard can scroll it to the end marker; Safari does
    // not focus a scroll container on its own
    <div className="assistant-confirm-scroll" role="region" aria-label="Writes to review"
      tabIndex={0}>
      <ol className="assistant-confirm-ops">
        {preview.ops.map((op, i) => (
          <li key={i} className="assistant-confirm-op">
            <div className="assistant-confirm-action">{op.action}</div>
            {op.targets.map(([key, value], j) => (
              <div key={j} className="assistant-confirm-target">
                <span className="assistant-confirm-key">{targetLabel(op, key)}</span>{": "}
                <bdi className="assistant-confirm-value" dir="ltr">{formatTarget(key, value)}</bdi>
              </div>
            ))}
            {op.current && (
              <CurrentRows current={op.current} moving={op.action === "move block"} />
            )}
            {/* a warning quotes values, so it reads left to right as a whole
              * however its quoted values are written */}
            {op.warnings.map((warning, j) => (
              <div key={j} className="assistant-confirm-warning" dir="ltr">⚠ {warning}</div>
            ))}
            {op.content.map(([key, text, total], j) => (
              <ContentValue key={j} name={key} text={text} total={total} />
            ))}
          </li>
        ))}
      </ol>
      <div className="assistant-confirm-end" ref={endRef} aria-hidden="true" />
    </div>
  );
}

function ConfirmCard({
  pending,
  count,
  answering,
  onAnswer,
  scrollerRef,
}: {
  pending: PendingConfirm;
  count: number;
  answering: boolean;
  onAnswer: (allow: boolean) => void;
  scrollerRef: RefObject<HTMLDivElement>;
}) {
  const { preview, sentDecision, allowedAhead } = pending;
  const cardRef = useRef<HTMLDivElement>(null);
  const startRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const [armed, setArmed] = useState(false);
  // the card opens at its heading, so an unseen start was scrolled past
  const [start, setStart] = useState<MarkerState>("above");
  const [end, setEnd] = useState<MarkerState>("below");
  useEffect(() => {
    const id = setTimeout(() => setArmed(true), ALLOW_ARM_MS);
    return () => clearTimeout(id);
  }, []);
  // A new card shows from its heading down, not from the transcript's
  // bottom. The transcript scrolls itself: scrollIntoView can also scroll the
  // document under the fixed panel in WebKit.
  useEffect(() => {
    const card = cardRef.current;
    const scroller = scrollerRef.current;
    if (!card || !scroller) return;
    scroller.scrollTop += card.getBoundingClientRect().top
      - scroller.getBoundingClientRect().top;
  }, [scrollerRef]);
  useEffect(() => {
    const startEl = startRef.current;
    const endEl = endRef.current;
    const scroller = scrollerRef.current;
    if (!startEl || !endEl || typeof IntersectionObserver === "undefined") return;
    // seen once is enough: the user has had the chance to read it
    const keepSeen = (place: "above" | "below") =>
      (prev: MarkerState): MarkerState => (prev === "seen" ? prev : place);
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        observer.unobserve(entry.target);
        if (entry.target === startEl) setStart("seen");
        else setEnd("seen");
      }
    });
    observer.observe(startEl);
    observer.observe(endEl);
    const measure = () => {
      if (!scroller) return;
      const view = scroller.getBoundingClientRect();
      const startPlace = placeOf(startEl.getBoundingClientRect(), view);
      const endPlace = placeOf(endEl.getBoundingClientRect(), view);
      if (startPlace) setStart(keepSeen(startPlace));
      if (endPlace) setEnd(keepSeen(endPlace));
    };
    // scroll does not bubble, but a capturing listener on the transcript
    // hears the list region's scrolls as well as its own
    scroller?.addEventListener("scroll", measure, { capture: true, passive: true });
    return () => {
      observer.disconnect();
      scroller?.removeEventListener("scroll", measure, { capture: true });
    };
  }, [scrollerRef]);
  // sentDecision is set by the hook only once it posts; the head stays only
  // after a failed post, so a sent decision that is not in flight failed
  const failed = sentDecision !== null && !answering;
  const n = preview?.ops.length ?? 0;
  const position = count > 1 ? ` (1 of ${count})` : "";
  const writes = n === 1 ? "write" : "writes";
  const hint = confirmHint(start, end);
  // only a block read from the store can have changed under an earlier
  // write, and only while the server's stamp says one could still land
  const readsStore = preview?.ops.some((op) =>
    op.current !== null && op.current.state !== "created") ?? false;
  const stale = readsStore && (preview?.writes_in_flight ?? false)
    && allowedAhead > 0;
  const cards = allowedAhead === 1
    ? "card, and its write" : "cards, and their writes";
  return (
    <div className="assistant-confirm-card" ref={cardRef}>
      <div className="assistant-confirm-start" ref={startRef} aria-hidden="true" />
      <div className="assistant-confirm-title">
        {preview
          ? `The assistant wants to make ${n} ${writes}${position}:`
          : `The assistant wants to write${position}:`}
      </div>
      {stale && (
        <div className="assistant-confirm-stale">
          {`You allowed ${allowedAhead} earlier ${cards} may have landed after `
            + "this card was read; the current text it shows may have changed."}
        </div>
      )}
      {preview ? (
        <PreviewOps preview={preview} endRef={endRef} />
      ) : (
        <div className="assistant-error">The write preview could not be read.</div>
      )}
      {preview && hint && !failed && <div className="assistant-confirm-hint">{hint}</div>}
      <div className="assistant-confirm-actions">
        {failed ? (
          <button
            type="button"
            className={sentDecision ? "btn-secondary" : "btn-danger"}
            onClick={() => onAnswer(sentDecision)}
          >
            {sentDecision ? "Retry Allow" : "Retry Deny"}
          </button>
        ) : (
          <>
            {preview && (
              <button
                type="button"
                className="btn-secondary"
                disabled={!armed || start !== "seen" || end !== "seen" || answering}
                onClick={() => onAnswer(true)}
              >
                Allow
              </button>
            )}
            <button
              type="button"
              className="btn-danger"
              disabled={answering}
              onClick={() => onAnswer(false)}
            >
              Deny
            </button>
          </>
        )}
      </div>
    </div>
  );
}

export function AssistantPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const assistant = useAssistant();
  const [draft, setDraft] = useState("");
  const listRef = useRef<HTMLDivElement>(null);

  // ticks the busy line's elapsed clock; idle/confirm renders no
  // clock, so no interval runs then
  const busy = assistant.status === "busy";
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!busy) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [busy]);

  useEffect(() => {
    // a confirm card scrolls its own top into view instead: pinning the
    // bottom would push a tall card's heading and first targets out of sight
    if (assistant.pendingConfirm) return;
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [assistant.items, assistant.pendingConfirm]);

  // the panel is mounted from app load; fetch the model list only when it
  // is actually opened (ensureModels retries a failed fetch on a later open)
  const { ensureModels } = assistant;
  useEffect(() => {
    if (open) ensureModels();
  }, [open, ensureModels]);

  if (!open) return null;

  const submit = () => {
    const text = draft.trim();
    if (!text || assistant.status !== "idle") return;
    setDraft("");
    void assistant.send(text);
  };

  return (
    <section
      className="assistant-panel"
      aria-label="Assistant"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <header className="assistant-header">
        <span className="assistant-title">Assistant</span>
        <label className="assistant-model">
          model
          <select
            className="input-control"
            value={assistant.model}
            disabled={assistant.modelLocked}
            onChange={(e) => assistant.setModel(e.target.value)}
          >
            {assistant.models.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        </label>
        <button type="button" className="btn-secondary" onClick={() => void assistant.newChat()}>
          New chat
        </button>
        <button type="button" className="assistant-close" aria-label="Close assistant" onClick={onClose}>
          ×
        </button>
      </header>
      <div className="assistant-messages" ref={listRef}>
        {/* A reply's text and media are the model's, so media waits for a click. */}
        <UntrustedContentContext.Provider value={true}>
          {/* seed={{}}: no page payload backs this panel, so every ((uid)) a
            * reply mentions is unseeded and resolved live. */}
          <BlockRefProvider seed={{}}>
            {assistant.items.map((item, i) =>
              item.kind === "tool" ? (
                <div key={i} className="assistant-tool-line">
                  {item.error !== null ? "✗" : item.declined ? "" : item.done ? "✓" : "…"}
                  {item.declined ? "" : " "}{item.summary}
                  {item.declined && (
                    <span className="assistant-tool-declined"> Declined</span>
                  )}
                  {item.error !== null && (
                    <div className="assistant-tool-failed">
                      Failed: <bdi dir="ltr">{item.error}</bdi>
                    </div>
                  )}
                </div>
              ) : (
                <div key={i} className={`assistant-msg assistant-msg-${item.kind}`}>
                  {item.kind === "assistant" ? (
                    <InlineSegments segments={tokenizeBlock(stripCaretBlockRefs(item.text))} />
                  ) : (
                    item.text
                  )}
                </div>
              ),
            )}
          </BlockRefProvider>
        </UntrustedContentContext.Provider>
        {assistant.pendingConfirm && (
          <ConfirmCard
            key={assistant.pendingConfirm.confirmId}
            pending={assistant.pendingConfirm}
            count={assistant.pendingConfirmCount}
            answering={assistant.answering}
            onAnswer={(allow) => void assistant.respondConfirm(allow)}
            scrollerRef={listRef}
          />
        )}
        {assistant.error && <div className="assistant-error">{assistant.error}</div>}
        {assistant.status === "busy" && (
          <div className="assistant-tool-line">
            {assistant.phase
              ? `${assistant.phase.label ?? "thinking"}… `
                + elapsedLabel({ sinceMs: assistant.phase.since, nowMs: now })
              : "thinking…"}
          </div>
        )}
      </div>
      <div className="assistant-input">
        <textarea
          className="input-control"
          placeholder="Ask about your notes…"
          value={draft}
          rows={2}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        {/* while an answer posts, or after its post failed and the card
          * offers only a retry, Stop is the way out of the confirm */}
        {assistant.status === "busy" || assistant.answering
          || (assistant.pendingConfirm?.sentDecision ?? null) !== null ? (
          <button type="button" className="btn-secondary" onClick={() => assistant.stop()}>
            Stop
          </button>
        ) : (
          <button
            type="button"
            className="btn-secondary"
            disabled={assistant.status !== "idle"}
            onClick={submit}
          >
            Send
          </button>
        )}
      </div>
    </section>
  );
}
