// pattern: Functional Core
// "Show timestamps" preference (bean pkm-4ler): whether main-pane pages
// render the block-stamp margin column. One global setting, not per page --
// it is peripheral awareness, and a per-page memory would make the column's
// absence look like missing data. Same shape as sidebar.ts: a bare string in
// localStorage, validated with a type guard.

export type BlockStampsPref = "on" | "off";

export const BLOCK_STAMPS_STORAGE_KEY = "pkm:block-stamps";

export function isBlockStampsPref(
  value: string | null | undefined,
): value is BlockStampsPref {
  return value === "on" || value === "off";
}

/** Flips the current value for a single toggle control. */
export function toggleBlockStampsPref(
  current: BlockStampsPref,
): BlockStampsPref {
  return current === "on" ? "off" : "on";
}
