// pattern: Imperative Shell
// In-app replacement for window.confirm. iPadOS Safari
// suppresses window.confirm/window.alert while the app runs standalone
// (added to home screen / installed as a PWA): the call returns `false`
// immediately without ever showing anything, so any destructive action
// gated on `if (!window.confirm(...)) return;` silently no-ops on iPad --
// there is no error, just nothing happens. useConfirm renders a real,
// accessible dialog and resolves a promise instead, giving every caller
// the same `if (!(await confirm(...))) return;` shape window.confirm used
// to, but one that actually works in standalone mode everywhere.
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface ConfirmOptions {
  /** Optional heading shown above the message. */
  heading?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Styles the confirm button as a destructive action. */
  danger?: boolean;
}

interface ConfirmState extends ConfirmOptions {
  message: string;
  resolve: (value: boolean) => void;
}

/** Renders (at most) one confirmation dialog for its owning component.
 * `confirm(message)` returns a promise that resolves `true`/`false` once
 * the user picks an option -- Escape and the Cancel button resolve
 * `false`; Enter and the confirm button resolve `true`, except that Enter
 * on a focused dialog button activates that button. A second `confirm()`
 * while one is pending resolves the pending one `false`. Render `dialog`
 * anywhere in the owning component's tree (it portals to `document.body`
 * and renders nothing when no confirmation is pending). */
export function useConfirm(): {
  confirm: (message: string, options?: ConfirmOptions) => Promise<boolean>;
  dialog: React.ReactNode;
} {
  const [state, setState] = useState<ConfirmState | null>(null);
  const confirmButtonRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  const confirm = useCallback(
    (message: string, options: ConfirmOptions = {}) =>
      new Promise<boolean>((resolve) => {
        setState((pending) => {
          pending?.resolve(false);
          return { message, resolve, ...options };
        });
      }),
    [],
  );

  const settle = useCallback((value: boolean) => {
    setState((current) => {
      current?.resolve(value);
      return null;
    });
  }, []);

  useEffect(() => {
    if (!state) return undefined;
    confirmButtonRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        settle(false);
      } else if (event.key === "Enter") {
        // A focused dialog button activates itself on Enter; settling here
        // would confirm when the focus is on Cancel.
        if (event.target instanceof HTMLButtonElement
            && dialogRef.current?.contains(event.target)) return;
        event.preventDefault();
        settle(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [state, settle]);

  const dialog = state && createPortal(
    <div className="confirm-dialog-overlay" onClick={() => settle(false)}>
      <div className="confirm-dialog" role="alertdialog" aria-modal="true"
           ref={dialogRef}
           aria-label={state.heading ?? state.message}
           onClick={(event) => event.stopPropagation()}>
        {state.heading !== undefined
          && <p className="confirm-dialog-title">{state.heading}</p>}
        <p className="confirm-dialog-message">{state.message}</p>
        <div className="confirm-dialog-actions">
          <button type="button" className="btn-secondary"
                  onClick={() => settle(false)}>
            {state.cancelLabel ?? "Cancel"}
          </button>
          <button type="button"
                  className={state.danger ? "btn-danger" : "btn-secondary"}
                  ref={confirmButtonRef}
                  onClick={() => settle(true)}>
            {state.confirmLabel ?? "OK"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );

  return { confirm, dialog };
}
