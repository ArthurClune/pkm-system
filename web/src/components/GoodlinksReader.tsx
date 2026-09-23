// pattern: Imperative Shell
// Full-screen reader for a GoodLinks copy, portalled to body like
// ImageOverlay. One fetch of GET /api/goodlinks/{id} (metadata plus
// server-sanitised HTML), then the article renders inside an
// `<iframe sandbox srcdoc>` with no scripts and no same-origin access. The
// srcdoc is the one place third-party HTML reaches the DOM, and it only
// ever receives that sanitised payload (see goodlinksReaderDoc.ts). Every
// failure state keeps Close working and shows the original link when the
// URL is known. A link GoodLinks holds no reader copy of arrives with empty
// html: the bar still shows it, and a note stands in for the iframe.
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { ApiError } from "../api/client";
import type { GoodlinksArticle } from "../api/payloads";
import { apiGet } from "../api/typedClient";
import { useEffectiveTheme } from "../useEffectiveTheme";
import { goodlinksIdFromHref } from "./goodlinks";
import { failureNote, formatSaved, READER_SANDBOX, readerDocument, type ReaderPalette } from "./goodlinksReaderDoc";
import { useOverlayDismiss } from "./useOverlayDismiss";

type ReaderState =
  | { status: "loading" }
  | { status: "ok"; article: GoodlinksArticle }
  | { status: "error"; note: string };

function readPalette(): ReaderPalette {
  const style = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  return {
    bg: read("--color-bg-surface", "#ffffff"),
    text: read("--color-text", "#3f4758"),
    link: read("--color-link-ext", "#7056f2"),
  };
}

export function GoodlinksReader({ href, onClose, triggerRef }: {
  href: string;
  onClose: () => void;
  triggerRef?: RefObject<HTMLButtonElement | null>;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const [state, setState] = useState<ReaderState>({ status: "loading" });
  const theme = useEffectiveTheme();
  // Re-read the tokens whenever the effective theme flips while open.
  const palette = useMemo(readPalette, [theme]);
  useOverlayDismiss(closeRef, onClose, triggerRef);

  useEffect(() => {
    let alive = true;
    const linkId = goodlinksIdFromHref(href);
    if (linkId === null) {
      setState({ status: "error", note: failureNote(404) });
      return;
    }
    apiGet("/api/goodlinks/{link_id}", { path: { link_id: linkId } }).then(
      (article) => { if (alive) setState({ status: "ok", article }); },
      (err: unknown) => {
        if (!alive) return;
        const note = err instanceof ApiError ? failureNote(err.status, err.detail) : failureNote(0);
        setState({ status: "error", note });
      },
    );
    return () => { alive = false; };
  }, [href]);

  const article = state.status === "ok" ? state.article : null;
  const title = article?.title || "Saved article";
  const saved = article ? formatSaved(article.added_at) : "";

  return createPortal(
    <div
      className="goodlinks-reader"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={(event) => event.stopPropagation()}
    >
      <div className="goodlinks-reader-bar">
        <div className="goodlinks-reader-meta">
          <span className="goodlinks-reader-title">{title}</span>
          {article && (
            <a href={article.url} target="_blank" rel="noreferrer">original</a>
          )}
          {saved && <span className="goodlinks-reader-saved">{saved}</span>}
        </div>
        <button type="button" className="btn-secondary" ref={closeRef} onClick={onClose}>
          Close
        </button>
      </div>
      {state.status === "ok" && state.article.html !== "" ? (
        <iframe
          className="goodlinks-reader-frame"
          title={title}
          sandbox={READER_SANDBOX}
          referrerPolicy="no-referrer"
          srcDoc={readerDocument(state.article.html, palette)}
        />
      ) : (
        <p className="goodlinks-reader-note" role="status">
          {state.status === "loading" ? "Loading…"
            : state.status === "ok" ? "Goodlinks has no reader copy of this page"
            : state.note}
        </p>
      )}
    </div>,
    document.body,
  );
}
