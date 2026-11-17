// pattern: Imperative Shell
// The one-line stand-in for media inside a table cell or query card. A PDF
// or image opens its full-screen viewer over the table; any other media
// goes to the line that holds it, which a plain table never shows a label
// for (cellMediaCore.ts). Nothing is fetched until the click.
import { type MouseEvent, useContext, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { SidebarContext } from "../contexts";
import { pagePath } from "../paths";
import type { LabelMedia } from "./cellMediaCore";
import { ImageOverlay } from "./ImageOverlay";
import { PdfEmbed } from "./PdfEmbed";

const ICON = { pdf: "📄", image: "🖼", line: "↗" } as const;

export function CellMediaLabel({ media }: { media: LabelMedia }) {
  const { openInSidebar } = useContext(SidebarContext);
  const navigate = useNavigate();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [broken, setBroken] = useState(false);

  const text = `${ICON[media.kind]} ${media.label}`
    + (broken ? " (unavailable)" : "");
  const close = () => setOpen(false);

  let ariaLabel: string | undefined;
  let activate: (event: MouseEvent) => void;
  if (media.kind === "line") {
    const { page, uid } = media;
    activate = (event) => {
      if (event.shiftKey) openInSidebar(page, uid);
      else void navigate(`${pagePath(page)}#${uid}`);
    };
  } else {
    const kind = media.kind === "pdf" ? "PDF" : "image";
    ariaLabel = `Open ${kind} full screen: ${media.label}`;
    activate = () => setOpen(true);
  }

  return (
    <>
      <button
        type="button"
        className="cell-media-label"
        aria-label={ariaLabel}
        ref={buttonRef}
        onClick={(event) => {
          // The <td> opens the cell editor on a click that reaches it.
          event.stopPropagation();
          activate(event);
        }}
      >
        {text}
      </button>
      {open && media.kind === "pdf" && (
        <PdfEmbed href={media.href} label={media.label} onClose={close}
                  triggerRef={buttonRef}
                  onError={() => {
                    setOpen(false);
                    setBroken(true);
                  }} />
      )}
      {open && media.kind === "image" && (
        <ImageOverlay
          src={media.src}
          alt={media.alt}
          onClose={close}
          onError={() => {
            setOpen(false);
            setBroken(true);
          }}
          triggerRef={buttonRef}
        />
      )}
    </>
  );
}
