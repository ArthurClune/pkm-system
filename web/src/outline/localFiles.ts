// pattern: Functional Core
// The /link-local-file picker's pure half that the outline imports: folder
// browsing over the flat local index and the `Local copy::` attribute text
// the command inserts. The fzf search lives in localSearch.ts so the entry
// chunk does not carry it.
import type { components } from "../api/types";
import { scanMarkdownLinkAt } from "../grammar/markdown";

export type LocalFile = components["schemas"]["LocalIndexFile"];

const byName = (a: string, b: string) =>
  a.localeCompare(b, undefined, { sensitivity: "base" });

export function fileName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

export function folderOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

export function folderListing(
  files: readonly LocalFile[],
  folder: string,
): { folders: string[]; files: LocalFile[] } {
  const prefix = folder === "" ? "" : `${folder}/`;
  const folders = new Set<string>();
  const direct: LocalFile[] = [];
  for (const file of files) {
    if (!file.path.startsWith(prefix)) continue;
    const rest = file.path.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (slash < 0) direct.push(file);
    else folders.add(rest.slice(0, slash));
  }
  return {
    folders: [...folders].sort(byName),
    files: direct.sort((a, b) => byName(a.path, b.path)),
  };
}

const ATTRIBUTE_PREFIX = "Local copy:: ";

// Keeps the real file name as the label when the link reads back with that
// label and destination; otherwise brackets in the name become parentheses.
export function localCopyAttribute(file: LocalFile): string {
  const name = fileName(file.path);
  const attempt = `${ATTRIBUTE_PREFIX}[${name}](${file.href})`;
  const link = scanMarkdownLinkAt(attempt, ATTRIBUTE_PREFIX.length);
  if (
    link &&
    link.end === attempt.length &&
    attempt.slice(link.label.start, link.label.end) === name &&
    attempt.slice(link.destination.start, link.destination.end) === file.href
  ) {
    return attempt;
  }
  const safe = name.replace(/\[/g, "(").replace(/\]/g, ")");
  return `${ATTRIBUTE_PREFIX}[${safe}](${file.href})`;
}
