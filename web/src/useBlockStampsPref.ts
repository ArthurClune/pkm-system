// pattern: Imperative Shell
import { useCallback } from "react";
import {
  BLOCK_STAMPS_STORAGE_KEY,
  isBlockStampsPref,
  toggleBlockStampsPref,
} from "./blockStampsPref";
import { useStoredPref } from "./useStoredPref";

/** Whether main-pane pages show the block-stamp margin column, persisted
 * across reloads. App.tsx owns the single instance and shares it through
 * BlockStampsContext: two independent instances would not re-render each
 * other, so the TopBar checkmark and the column itself would disagree until
 * the next route change. */
export function useBlockStampsPref() {
  const [pref, setPref] =
    useStoredPref(BLOCK_STAMPS_STORAGE_KEY, isBlockStampsPref, "off");
  const toggle = useCallback(() => setPref(toggleBlockStampsPref), [setPref]);
  return { stamps: pref === "on", toggle };
}
