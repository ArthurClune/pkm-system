// pattern: Imperative Shell
// The resting state of a GoodLinks copy: a link-styled button inside
// `.block-text`. Nothing is fetched until it is clicked; the click is an
// interactive island (stopPropagation) so it does not re-enter block-edit
// mode, then the reader overlay mounts and owns the fetch.
import { useRef, useState } from "react";
import { GoodlinksReader } from "./GoodlinksReader";

export function GoodlinksLink({ href, label }: { href: string; label: string }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        type="button"
        ref={triggerRef}
        className="goodlinks-link"
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
      >
        {label || "Goodlinks"}
      </button>
      {open && (
        <GoodlinksReader href={href} onClose={() => setOpen(false)} triggerRef={triggerRef} />
      )}
    </>
  );
}
