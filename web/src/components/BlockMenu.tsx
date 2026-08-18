// pattern: Imperative Shell
// Dumb fixed-position context menu for a block (opened from its bullet).
// Owns focus and roving keyboard navigation; picking an item runs its action,
// then closes. Escape/click-away dismissal is the shared contract
// (useDismiss.ts), so the keydown listener below handles only the
// menu-specific keys.
import { Fragment, useEffect, useRef } from "react";
import { useDismiss } from "../useDismiss";

export interface BlockMenuItem {
  label: string;
  action: () => void;
  checked?: boolean;
  disabled?: boolean;
  group?: string;
}

export function BlockMenu({ x, y, items, onClose }: {
  x: number; y: number; items: BlockMenuItem[]; onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useDismiss(ref, onClose, { preventDefaultOnEscape: true });
  useEffect(() => {
    const enabledItems = () => Array.from(
      ref.current?.querySelectorAll<HTMLButtonElement>(
        ".block-menu-item:not(:disabled)",
      ) ?? [],
    );
    enabledItems()[0]?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Tab") {
        onClose();
        return;
      }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
      const buttons = enabledItems();
      if (buttons.length === 0) return;
      e.preventDefault();
      const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
      if (e.key === "Home") buttons[0].focus();
      else if (e.key === "End") buttons.at(-1)?.focus();
      else if (e.key === "ArrowDown") buttons[(current + 1) % buttons.length].focus();
      else buttons[(current - 1 + buttons.length) % buttons.length].focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="block-menu" role="menu" aria-label="Block actions" ref={ref}
         style={{ left: x, top: y }}>
      {items.map((it, index) => {
        const showGroup = it.group !== undefined && it.group !== items[index - 1]?.group;
        const isRadio = it.checked !== undefined;
        return (
          <Fragment key={`${it.group ?? "action"}:${it.label}`}>
            {showGroup && (
              <div className="block-menu-group" aria-hidden="true">{it.group}</div>
            )}
            <button role={isRadio ? "menuitemradio" : "menuitem"}
                    aria-checked={isRadio ? it.checked : undefined}
                    disabled={it.disabled}
                    className="block-menu-item"
                    onClick={() => {
                      if (it.disabled) return;
                      it.action();
                      onClose();
                    }}>
              {isRadio && (
                <span className="block-menu-item-check" aria-hidden="true">
                  {it.checked ? "✓" : ""}
                </span>
              )}
              {it.label}
            </button>
          </Fragment>
        );
      })}
    </div>
  );
}
