// pattern: Imperative Shell
// Floating assistant chat panel (bottom-right overlay; not a route).

import { useEffect, useRef, useState } from "react";
import { BlockRefProvider } from "../components/BlockRefProvider";
import { InlineSegments } from "../components/InlineSegments";
import { tokenizeBlock } from "../grammar/tokenize";
import { useAssistant } from "./useAssistant";

const MODELS = ["sonnet", "opus", "haiku"];

// pkm-c98s item 6: the server only clips ops_preview at a generous 4000
// chars (see policy.py); this is a purely visual collapse so the approval
// card doesn't dominate the panel for a long batch, with a toggle to see
// everything the server actually sent.
const PREVIEW_COLLAPSE_THRESHOLD = 300;

function ConfirmCard({
  opsPreview,
  onAllow,
  onDeny,
}: {
  opsPreview: string;
  onAllow: () => void;
  onDeny: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const isLong = opsPreview.length > PREVIEW_COLLAPSE_THRESHOLD;
  const shown = isLong && !expanded ? opsPreview.slice(0, PREVIEW_COLLAPSE_THRESHOLD) + "…" : opsPreview;
  return (
    <div className="assistant-confirm-card">
      <div className="assistant-confirm-title">The assistant wants to write:</div>
      <pre>{shown}</pre>
      {isLong && (
        <button
          type="button"
          className="assistant-preview-toggle"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? "Show less" : "Show full preview"}
        </button>
      )}
      <div className="assistant-confirm-actions">
        <button type="button" className="btn-secondary" onClick={onAllow}>
          Allow
        </button>
        <button type="button" className="btn-danger" onClick={onDeny}>
          Deny
        </button>
      </div>
    </div>
  );
}

export function AssistantPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const assistant = useAssistant();
  const [draft, setDraft] = useState("");
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [assistant.items, assistant.pendingConfirm]);

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
            value={assistant.model}
            disabled={assistant.modelLocked}
            onChange={(e) => assistant.setModel(e.target.value)}
          >
            {MODELS.map((m) => (
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
        {/* seed={{}}: no page payload backs this panel, so every ((uid)) a
          * reply mentions is unseeded and resolved live (pkm-gdi5). */}
        <BlockRefProvider seed={{}}>
          {assistant.items.map((item, i) =>
            item.kind === "tool" ? (
              <div key={i} className="assistant-tool-line">
                {item.done ? "✓" : "…"} {item.summary}
              </div>
            ) : (
              <div key={i} className={`assistant-msg assistant-msg-${item.kind}`}>
                {item.kind === "assistant" ? (
                  <InlineSegments segments={tokenizeBlock(item.text)} />
                ) : (
                  item.text
                )}
              </div>
            ),
          )}
        </BlockRefProvider>
        {assistant.pendingConfirm && (
          <ConfirmCard
            key={assistant.pendingConfirm.toolUseId}
            opsPreview={assistant.pendingConfirm.opsPreview}
            onAllow={() => void assistant.respondConfirm(true)}
            onDeny={() => void assistant.respondConfirm(false)}
          />
        )}
        {assistant.error && <div className="assistant-error">{assistant.error}</div>}
        {assistant.status === "busy" && <div className="assistant-tool-line">thinking…</div>}
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
        {assistant.status === "busy" ? (
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
