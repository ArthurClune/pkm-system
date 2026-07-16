// pattern: Imperative Shell
// Entry point for PDF asset links. The real viewer (react-pdf + pdfjs-dist,
// several hundred KB) is loaded lazily on first render, MermaidDiagram-style:
// a module-level cached import() promise shared by every PDF on the page,
// reset on failure so one bad load doesn't wedge later attempts. Until the
// chunk arrives (and if it never does) the plain download link renders, so
// degraded behaviour is never worse than the pre-viewer UI.
import { type ComponentType, useEffect, useState } from "react";
import { PdfFallbackLink } from "./PdfFallbackLink";

type ViewerProps = { href: string; label: string };

let viewerPromise: Promise<ComponentType<ViewerProps>> | null = null;

function loadViewer(): Promise<ComponentType<ViewerProps>> {
  if (!viewerPromise) {
    viewerPromise = import("./PdfViewer").then((m) => m.PdfViewer);
    viewerPromise.catch(() => {
      viewerPromise = null;
    });
  }
  return viewerPromise;
}

type ViewerState =
  | { status: "loading" }
  | { status: "ok"; Viewer: ComponentType<ViewerProps> }
  | { status: "error" };

export function PdfEmbed({ href, label }: ViewerProps) {
  const [state, setState] = useState<ViewerState>({ status: "loading" });

  useEffect(() => {
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
  }, []);

  if (state.status === "loading") return <PdfFallbackLink href={href} label={label} />;
  if (state.status === "error") {
    return <PdfFallbackLink href={href} label={label} note="Couldn't load the PDF viewer." />;
  }
  const { Viewer } = state;
  return <Viewer href={href} label={label} />;
}
