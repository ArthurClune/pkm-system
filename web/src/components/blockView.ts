// pattern: Functional Core
// A block's view_type controls its direct children only: it does not cascade
// to deeper levels. Null means the document default (plain bullets).
import type { BlockNode } from "../api/payloads";

export type EffectiveBlockView = "numbered" | "document";

export function effectiveChildView(
  explicit: BlockNode["view_type"],
): EffectiveBlockView {
  return explicit ?? "document";
}
