// pattern: Functional Core
// Dumb fixed-position context menu for a block (opened from its bullet).
// Owns only its own dismissal: Escape and click-away call onClose; picking
// an item runs its action, then closes.
import { useEffect, useRef } from "react";

export interface BlockMenuItem {
  label: string;
  action: () => void;
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
      {items.map((it) => (
        <button key={it.label} role="menuitem" className="block-menu-item"
                onClick={() => { it.action(); onClose(); }}>
          {it.label}
        </button>
      ))}
    </div>
  );
}
