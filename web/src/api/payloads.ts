// Ergonomic names for the read-API response shapes. These are now generated
// from the server's Pydantic response models (see server response_models.py),
// flow through openapi.json into types.d.ts, and are guarded against drift by
// server/tests/test_openapi_sync.py. This module only re-exports the generated
// schemas under their short names — do not hand-edit the shapes here.
import type { components } from "./types";

type Schemas = components["schemas"];

export type PageMeta = Schemas["PageMeta"];
export type BlockNode = Schemas["BlockNode"];
export type BacklinkItem = Schemas["BacklinkItem"];
export type BacklinkGroup = Schemas["BacklinkGroup"];
export type Backlinks = Schemas["Backlinks"];
export type BlockRefText = Schemas["BlockRefText"];
export type BlockRefsPayload = Schemas["BlockRefsPayload"];
export type PagePayload = Schemas["PagePayload"];

/** Shared by /api/unlinked and /api/query (both return {groups, total}). */
export type GroupItem = Schemas["GroupItem"];
export type BlockGroup = Schemas["BlockGroup"];
export type GroupsPayload = Schemas["GroupsPayload"];

export type JournalDay = Schemas["JournalDay"];
export type JournalPayload = Schemas["JournalPayload"];

export type SearchPageHit = Schemas["SearchPageHit"];
export type SearchBlockHit = Schemas["SearchBlockHit"];
export type SearchPayload = Schemas["SearchPayload"];

export type TitlesPayload = Schemas["TitlesPayload"];

export type SidebarNavEntry = Schemas["SidebarNavEntry"];
export type SidebarNavPayload = Schemas["SidebarNavPayload"];
