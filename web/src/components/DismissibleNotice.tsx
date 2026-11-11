// pattern: Imperative Shell
import type { ReactNode } from "react";

/** A notice line with its own Dismiss button. An error is announced as an
 * alert, a status politely; the classes are what styles.css and the e2e
 * locators already select on. */
export function DismissibleNotice({ tone, onDismiss, className, children }: {
  tone: "error" | "status";
  onDismiss: () => void;
  /** Added to the tone's classes. */
  className?: string;
  children: ReactNode;
}) {
  const toneClass = tone === "error" ? "error upload-error" : "editor-notice";
  return (
    <p className={className ? `${toneClass} ${className}` : toneClass}
       role={tone === "error" ? "alert" : "status"}>
      {children}
      <button type="button" className="btn-secondary" onClick={onDismiss}>
        Dismiss
      </button>
    </p>
  );
}
