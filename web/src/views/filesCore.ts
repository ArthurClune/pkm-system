// pattern: Functional Core
// Pure logic for the /files asset browser (pkm-jdu3). The Files view is
// the imperative shell; everything testable without I/O lives here.
import type { AssetSearchItem, BacklinkGroup } from "../api/payloads";

export interface FileFilters {
  q: string;
  type: "" | "image" | "pdf" | "document" | "other";
  fromDate: string; // yyyy-mm-dd or ""
  toDate: string;
  linked: "all" | "linked" | "orphan";
}

export const EMPTY_FILTERS: FileFilters = {
  q: "", type: "", fromDate: "", toDate: "", linked: "all",
};

export const PAGE_SIZE = 50;

// Date-only strings parse as UTC midnight per spec; construct via local
// components instead so the day boundary is the user's, not UTC's.
function localMs(date: string, endOfDay: boolean): number {
  const [y, m, d] = date.split("-").map(Number);
  return endOfDay
    ? new Date(y, m - 1, d, 23, 59, 59, 999).getTime()
    : new Date(y, m - 1, d).getTime();
}

export function searchQuery(f: FileFilters, offset: number) {
  return {
    q: f.q.trim() || undefined,
    type: f.type || undefined,
    from_ms: f.fromDate ? localMs(f.fromDate, false) : undefined,
    to_ms: f.toDate ? localMs(f.toDate, true) : undefined,
    linked: f.linked === "all" ? undefined : f.linked,
    limit: PAGE_SIZE,
    offset,
  };
}

const DOCUMENT_MIME = new Set([
  "application/json",
  "application/msword", "application/vnd.ms-excel",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument"
    + ".wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument"
    + ".spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument"
    + ".presentationml.presentation",
]);

export function mimeCategory(
  mime: string,
): "image" | "pdf" | "document" | "other" {
  if (mime.startsWith("image/")) return "image";
  if (mime === "application/pdf") return "pdf";
  if (mime.startsWith("text/") || DOCUMENT_MIME.has(mime)) {
    return "document";
  }
  return "other";
}

export function clipboardToken(
  item: Pick<AssetSearchItem, "filename" | "mime" | "url">,
): string {
  const bang = item.mime.startsWith("image/") ? "!" : "";
  return `${bang}[${item.filename}](${item.url})`;
}

const plural = (n: number, word: string) =>
  `${n} ${word}${n === 1 ? "" : "s"}`;

export function deleteConfirm(
  items: AssetSearchItem[],
): { message: string; loud: boolean } {
  const linked = items.filter((i) => i.refs.length > 0);
  const head = `Delete ${plural(items.length, "file")}?`;
  if (linked.length === 0) {
    return { message: `${head} None are linked from any page.`,
             loud: false };
  }
  const lines = linked.map((i) => {
    const pages = [...new Set(i.refs.map((r) => r.page_title))];
    return `${i.filename} — linked from ${pages.join(", ")}`;
  });
  const refs = linked.reduce((sum, i) => sum + i.refs.length, 0);
  const still = linked.length === 1 ? "1 is" : `${linked.length} are`;
  return {
    loud: true,
    message: `${head} ${still} still linked:\n${lines.join("\n")}\n`
      + `This removes ${plural(refs, "link")} from `
      + `${plural(refs, "block")}; blocks left empty are deleted.`,
  };
}

export function summarizeDeletes(ok: number, failures: string[]): string {
  if (failures.length === 0) return `Deleted ${plural(ok, "file")}.`;
  return `Deleted ${ok} of ${ok + failures.length} files.`
    + ` Failed: ${failures.join(", ")}`;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export interface AssetRef {
  uid: string;
  page_title: string;
}

// GET /api/block-refs rejects more than 50 uids per call.
const BLOCK_REFS_CAP = 50;

export function refUidChunks(refs: readonly AssetRef[]): string[][] {
  const chunks: string[][] = [];
  for (let i = 0; i < refs.length; i += BLOCK_REFS_CAP) {
    chunks.push(refs.slice(i, i + BLOCK_REFS_CAP).map((r) => r.uid));
  }
  return chunks;
}

export const MISSING_BLOCK_TEXT = "(block not found)";

// Shape an asset's refs for BacklinkGroupList. page_id is a synthetic
// key (the search payload carries no page ids) and breadcrumbs aren't
// available here, so rows carry text only.
export function refGroups(
  refs: readonly AssetRef[],
  texts: Record<string, { text: string; page_title: string }>,
): BacklinkGroup[] {
  const groups: BacklinkGroup[] = [];
  const byTitle = new Map<string, BacklinkGroup>();
  for (const ref of refs) {
    let group = byTitle.get(ref.page_title);
    if (group === undefined) {
      group = { page_id: groups.length, page_title: ref.page_title,
                items: [] };
      byTitle.set(ref.page_title, group);
      groups.push(group);
    }
    group.items.push({
      uid: ref.uid,
      text: texts[ref.uid]?.text ?? MISSING_BLOCK_TEXT,
      breadcrumbs: [],
    });
  }
  return groups;
}
