// pattern: Functional Core
// Dumb fixed-position context menu for a block (opened from its bullet).
// Owns only its own dismissal: Escape and click-away call onClose; picking
// an item runs its action, then closes.
import { Fragment, useEffect, useRef } from "react";

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
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);
  return (
    <div className="block-menu" role="menu" ref={ref}
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
