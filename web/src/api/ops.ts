// Type-only aliases over the generated OpenAPI schema (src/api/types.d.ts):
// the server's Pydantic op models are the single source of truth for what
// the editor is allowed to send.
import type { Sha256Hex } from "../replica/sha256";
import type { components } from "./types";

export type CreateOp = components["schemas"]["CreateOp"];
// Narrows the generated base_text_hash (string | null | undefined) to the
// branded hash type: a plain string can never stand in for a hash.
export type UpdateTextOp =
  Omit<components["schemas"]["UpdateTextOp"], "base_text_hash">
  & { base_text_hash?: Sha256Hex | null };
export type MoveOp = components["schemas"]["MoveOp"];
export type DeleteOp = components["schemas"]["DeleteOp"];
export type SetCollapsedOp = components["schemas"]["SetCollapsedOp"];
export type SetHeadingOp = components["schemas"]["SetHeadingOp"];
export type SetViewTypeOp = components["schemas"]["SetViewTypeOp"];
export type CreatePageOp = components["schemas"]["CreatePageOp"];

export type BlockOp =
  | CreateOp | UpdateTextOp | MoveOp | DeleteOp | SetCollapsedOp
  | SetHeadingOp | SetViewTypeOp | CreatePageOp;
