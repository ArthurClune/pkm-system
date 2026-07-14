// pattern: Functional Core
// A block's view_type controls its children. Null inherits the mode used for
// the block itself; the renderer supplies "document" at the outline root.
import type { BlockNode } from "../api/payloads";

export type EffectiveBlockView = "numbered" | "document";

export function effectiveChildView(
  inherited: EffectiveBlockView,
  explicit: BlockNode["view_type"],
): EffectiveBlockView {
  return explicit ?? inherited;
}
