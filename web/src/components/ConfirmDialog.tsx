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
import { useCallback, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useModal } from "../useModal";

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
  /** Bumped by every confirm() call: the card is keyed by it, so a second
   * confirm remounts the card and refocuses its confirm button. */
  opening: number;
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
  const openings = useRef(0);

  // The pending promise's resolver, kept out of state so that settling it
  // never happens inside a state updater, which React may run twice.
  const pendingResolve = useRef<((value: boolean) => void) | null>(null);

  const settle = useCallback((value: boolean) => {
    const resolve = pendingResolve.current;
    pendingResolve.current = null;
    resolve?.(value);
    setState(null);
  }, []);

  const confirm = useCallback(
    (message: string, options: ConfirmOptions = {}) =>
      new Promise<boolean>((resolve) => {
        pendingResolve.current?.(false);
        pendingResolve.current = resolve;
        openings.current += 1;
        setState({ message, ...options, opening: openings.current });
      }),
    [],
  );

  const dialog = state && createPortal(
    <ConfirmCard key={state.opening} state={state} settle={settle} />,
    document.body,
  );

  return { confirm, dialog };
}

function ConfirmCard({ state, settle }: {
  state: ConfirmState;
  settle: (value: boolean) => void;
}) {
  const confirmButtonRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  useModal({
    surfaceRef: dialogRef,
    initialFocusRef: confirmButtonRef,
    onClose: () => settle(false),
    onKey: (event) => {
      if (event.key !== "Enter") return;
      // A focused dialog button activates itself on Enter; settling here
      // would confirm when the focus is on Cancel.
      if (event.target instanceof HTMLButtonElement
          && dialogRef.current?.contains(event.target)) return;
      event.preventDefault();
      settle(true);
    },
  });

  return (
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
    </div>
  );
}
