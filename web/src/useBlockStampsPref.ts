// pattern: Imperative Shell
import { useCallback, useEffect, useState } from "react";
import {
  BLOCK_STAMPS_STORAGE_KEY,
  isBlockStampsPref,
  toggleBlockStampsPref,
  type BlockStampsPref,
} from "./blockStampsPref";

function readStoredPref(): BlockStampsPref {
  try {
    const stored = localStorage.getItem(BLOCK_STAMPS_STORAGE_KEY);
    return isBlockStampsPref(stored) ? stored : "off";
  } catch {
    return "off"; // localStorage unavailable (private mode / disabled)
  }
}

function persistPref(pref: BlockStampsPref) {
  try {
    localStorage.setItem(BLOCK_STAMPS_STORAGE_KEY, pref);
  } catch {
    // Not persisted this session; the in-memory value still works.
  }
}

/** Whether main-pane pages show the block-stamp margin column, persisted
 * across reloads. App.tsx owns the single instance and shares it through
 * BlockStampsContext: two independent instances would not re-render each
 * other, so the TopBar checkmark and the column itself would disagree until
 * the next route change. */
export function useBlockStampsPref() {
  const [pref, setPref] = useState<BlockStampsPref>(readStoredPref);

  useEffect(() => {
    persistPref(pref);
  }, [pref]);

  const toggle = useCallback(() => setPref(toggleBlockStampsPref), []);

  return { stamps: pref === "on", toggle };
}
