// pattern: Imperative Shell
// Shown instead of the delete confirmation when blocks would break if the
// page's links were unlinked, and after an asset delete the server refused
// for the blocks it would break. Same overlay and classes as ConfirmDialog.
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import { pagePath } from "../paths";
import {
  BLOCKED_LEAD, blockerExcerpt, blockerReasonLabel, type DeleteBlocker,
} from "./deletePageCopy";

/** `label` says why each block stops the delete; a page delete's reasons
 * by default. */
export function DeleteBlockedDialog({
  heading, blockers, label = blockerReasonLabel, onClose,
}: {
  heading: string;
  blockers: DeleteBlocker[];
  label?: (reason: DeleteBlocker["reason"]) => string;
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
          {heading}
        </p>
        <p className="confirm-dialog-message">{BLOCKED_LEAD}</p>
        <ul className="confirm-dialog-message">
          {blockers.map((b) => (
            <li key={b.uid}>
              <Link to={pagePath(b.page_title)} onClick={onClose}>
                {b.page_title}
              </Link>
              {": "}{blockerExcerpt(b)}{" ("}{label(b.reason)}{")"}
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
