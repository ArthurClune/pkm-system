// pattern: Imperative Shell
// Entry point for PDF asset links. The real viewer (react-pdf + pdfjs-dist,
// several hundred KB) is loaded lazily on first render, MermaidDiagram-style:
// a module-level cached import() promise shared by every PDF on the page,
// reset on failure so one bad load doesn't wedge later attempts. Until the
// chunk arrives (and if it never does) the plain download link renders, so
// degraded behaviour is never worse than the pre-viewer UI.
//
// `deferred` embeds (local-copy PDFs) go one step further: they
// rest as the plain link plus an Open button and import nothing until
// clicked. A page that lists dozens of `Local copy::` papers would otherwise
// fetch and parse every one of them on render, and each evicted file would
// kick off an iCloud download on the host.
import {
  type ComponentType, type MouseEvent, type RefObject, useEffect, useRef, useState,
} from "react";
import { lazyLoader } from "./lazyComponent";
import { PdfFallbackLink } from "./PdfFallbackLink";
import { hostFailureNote } from "./pdfViewerCore";

type ViewerProps = {
  href: string; label: string; onClose?: () => void;
  /** Overlay mode: focus returns here on close. A click in WebKit does not
   * focus the button that opened the overlay. */
  triggerRef?: RefObject<HTMLElement | null>;
};
type EmbedProps = ViewerProps & {
  deferred?: boolean;
  /** Overlay mode: the viewer chunk failed. With it set, nothing renders
   * inline and the caller closes; a table cell must not grow a link. */
  onError?: () => void;
};

const loadViewer = lazyLoader(() => import("./PdfViewer").then((m) => m.PdfViewer));

type ViewerState =
  | { status: "loading" }
  | { status: "ok"; Viewer: ComponentType<ViewerProps> }
  | { status: "error" };

const LOCAL_PREFIX = "/api/local/";

// The local route answers a missing or evicted file with a JSON error body,
// which a plain download link would save as `<name>.pdf.json`. Ask for one
// byte first (the route has no HEAD handler); on success hand the href to the
// browser's own download through a temporary anchor so the PDF is never
// buffered here. Resolves to a note, or null when the download was started.
async function probeAndDownload(href: string): Promise<string | null> {
  let res: Response;
  try {
    res = await fetch(href, { headers: { Range: "bytes=0-0" }, credentials: "same-origin" });
  } catch {
    return hostFailureNote(null);
  }
  void res.body?.cancel().catch(() => {});
  if (!res.ok) return hostFailureNote(res.status);
  const a = document.createElement("a");
  a.href = href;
  a.download = "";
  document.body.appendChild(a);
  a.click();
  a.remove();
  return null;
}

export function PdfEmbed({ href, label, onClose, triggerRef, onError,
                          deferred = false }: EmbedProps) {
  const overlay = onClose !== undefined;
  const [armed, setArmed] = useState(!deferred);
  const [state, setState] = useState<ViewerState>(() => {
    const Viewer = overlay ? loadViewer.peek() : undefined;
    return Viewer ? { status: "ok", Viewer } : { status: "loading" };
  });
  const [probeNote, setProbeNote] = useState<string | undefined>();
  const probing = useRef(false);
  const mounted = useRef(false);
  useEffect(() => {
    // Set here, not only in useRef: StrictMode's dev replay runs the cleanup
    // and then this body again, so a ref set once would stay false.
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const onDownload = href.startsWith(LOCAL_PREFIX)
    ? (e: MouseEvent) => {
        // Same island rule as Open; the native download waits on the probe.
        e.stopPropagation();
        e.preventDefault();
        if (probing.current) return;
        probing.current = true;
        void probeAndDownload(href).then((note) => {
          probing.current = false;
          if (mounted.current) setProbeNote(note ?? undefined);
        });
      }
    : undefined;

  useEffect(() => {
    if (!armed) return;
    let alive = true;
    loadViewer().then(
      (Viewer) => {
        if (alive) setState({ status: "ok", Viewer });
      },
      () => {
        if (alive) setState({ status: "error" });
      },
    );
    return () => {
      alive = false;
    };
  }, [armed]);

  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const failed = state.status === "error";
  useEffect(() => {
    if (failed && overlay) onErrorRef.current?.();
  }, [failed, overlay]);

  if (!armed) {
    return (
      <PdfFallbackLink
        href={href}
        label={label}
        note={probeNote}
        onDownload={onDownload}
        onOpen={(e) => {
          // Interactive island inside `.block-text`: an unstopped click
          // re-enters block-edit mode and unmounts this embed.
          e.stopPropagation();
          setArmed(true);
        }}
      />
    );
  }
  // An overlay opens over the page; until it can, nothing shows in place.
  if (state.status === "loading") {
    return overlay ? null : <PdfFallbackLink href={href} label={label} />;
  }
  if (state.status === "error") {
    if (overlay && onError !== undefined) return null;
    return <PdfFallbackLink href={href} label={label} note="Couldn't load the PDF viewer." />;
  }
  const { Viewer } = state;
  // A new href is a new document: remounting drops the old one's state and
  // any load still in flight for it.
  return <Viewer key={href} href={href} label={label} onClose={onClose}
                 triggerRef={triggerRef} />;
}
