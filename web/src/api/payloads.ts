// Response payload shapes for the read API. These mirror the server's dict
// responses (routes_pages.py, routes_search.py) — the OpenAPI schema only
// carries request models (see src/api/types.d.ts), so responses are pinned
// here by hand and exercised by tests using fixture payloads of this shape.

export interface PageMeta {
  id: number;
  title: string;
  created_at: number | null;
  updated_at: number | null;
}

export interface BlockNode {
  uid: string;
  text: string;
  heading: number | null;
  collapsed: boolean;
  order_idx: number;
  created_at: number | null;
  updated_at: number | null;
  children: BlockNode[];
}

export interface BacklinkItem {
  uid: string;
  text: string;
  breadcrumbs: string[];
}

export interface BacklinkGroup {
  page_id: number;
  page_title: string;
  items: BacklinkItem[];
}

export interface Backlinks {
  groups: BacklinkGroup[];
  total_pages: number;
  offset: number;
  limit: number;
}

export interface BlockRefText {
  text: string;
  page_title: string;
}

export interface PagePayload {
  page: PageMeta;
  blocks: BlockNode[];
  backlinks: Backlinks;
  block_ref_texts: Record<string, BlockRefText>;
}

/** Shared by /api/unlinked and /api/query (both return {groups, total}). */
export interface GroupItem {
  uid: string;
  text: string;
}

export interface BlockGroup {
  page_id: number;
  page_title: string;
  items: GroupItem[];
}

export interface GroupsPayload {
  groups: BlockGroup[];
  total: number;
}

export interface JournalDay {
  date: string;   // ISO yyyy-mm-dd
  title: string;  // Roam ordinal title, e.g. "July 8th, 2026"
  exists: boolean;
  blocks: BlockNode[];
}

export interface JournalPayload {
  days: JournalDay[];
}

export interface SearchPageHit {
  id: number;
  title: string;
}

export interface SearchBlockHit {
  uid: string;
  page_title: string;
  snippet: string; // contains literal <mark>…</mark> from FTS5
}

export interface SearchPayload {
  pages: SearchPageHit[];
  blocks: SearchBlockHit[];
}

export interface TitlesPayload {
  titles: string[];
}
