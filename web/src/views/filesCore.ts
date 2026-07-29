// pattern: Functional Core
// Pure logic for the /files asset browser (pkm-jdu3). The Files view is
// the imperative shell; everything testable without I/O lives here.
import type { AssetSearchItem } from "../api/payloads";

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

export function searchParams(f: FileFilters, offset: number): string {
  const p = new URLSearchParams();
  if (f.q.trim()) p.set("q", f.q.trim());
  if (f.type) p.set("type", f.type);
  if (f.fromDate) p.set("from_ms", String(localMs(f.fromDate, false)));
  if (f.toDate) p.set("to_ms", String(localMs(f.toDate, true)));
  if (f.linked !== "all") p.set("linked", f.linked);
  p.set("limit", String(PAGE_SIZE));
  p.set("offset", String(offset));
  return p.toString();
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
