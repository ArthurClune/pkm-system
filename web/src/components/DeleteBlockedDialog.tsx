// pattern: Imperative Shell
// Shown instead of the delete confirmation when blocks would break if the
// page's links were unlinked. Same overlay and classes as ConfirmDialog.
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import { pagePath } from "../paths";
import {
  BLOCKED_LEAD, blockedHeading, blockerReasonLabel, type DeleteBlocker,
} from "./deletePageCopy";

export function DeleteBlockedDialog({ title, blockers, onClose }: {
  title: string;
  blockers: DeleteBlocker[];
  onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const headingId = "delete-blocked-heading";
  return createPortal(
    <div className="confirm-dialog-overlay" onClick={onClose}>
      <div className="confirm-dialog" role="dialog" aria-modal="true"
           aria-labelledby={headingId}
           onClick={(event) => event.stopPropagation()}>
        <p className="confirm-dialog-title" id={headingId}>
          {blockedHeading(title)}
        </p>
        <p className="confirm-dialog-message">{BLOCKED_LEAD}</p>
        <ul className="confirm-dialog-message">
          {blockers.map((b) => (
            <li key={b.uid}>
              <Link to={pagePath(b.page_title)} onClick={onClose}>
                {b.page_title}
              </Link>
              {": "}{b.text}{" ("}{blockerReasonLabel(b.reason)}{")"}
            </li>
          ))}
        </ul>
        <div className="confirm-dialog-actions">
          <button type="button" className="btn-secondary" ref={closeRef}
                  onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
