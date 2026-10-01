// Type-only aliases over the generated OpenAPI schema (src/api/types.d.ts):
// the server's Pydantic op models are the single source of truth for what
// the editor is allowed to send.
import type { components } from "./types";

export type CreateOp = components["schemas"]["CreateOp"];
export type UpdateTextOp = components["schemas"]["UpdateTextOp"];
export type MoveOp = components["schemas"]["MoveOp"];
export type DeleteOp = components["schemas"]["DeleteOp"];
export type SetCollapsedOp = components["schemas"]["SetCollapsedOp"];
export type SetHeadingOp = components["schemas"]["SetHeadingOp"];
export type SetViewTypeOp = components["schemas"]["SetViewTypeOp"];
export type CreatePageOp = components["schemas"]["CreatePageOp"];

// A block's heading level with "plain text" (null) excluded, for call
// sites that always have a concrete level in hand (keyboard shortcuts,
// slash commands). Derived from the generated schema rather than
// hand-copied so a server-side level added later can't drift out of sync.
export type HeadingLevel = Exclude<SetHeadingOp["heading"], null | undefined>;

export type BlockOp =
  | CreateOp | UpdateTextOp | MoveOp | DeleteOp | SetCollapsedOp
  | SetHeadingOp | SetViewTypeOp | CreatePageOp;
