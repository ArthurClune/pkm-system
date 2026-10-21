// pattern: Functional Core
// The /link-local-file picker's pure half: folder browsing over the flat
// local index, fzf search with highlight ranges, and the `Local copy::`
// attribute text the command inserts.
import {
  Fzf,
  byLengthAsc,
  extendedMatch,
  type FzfResultItem,
  type Tiebreaker,
} from "fzf";
import type { components } from "../api/types";
import { scanMarkdownLinkAt } from "../grammar/markdown";

export type LocalFile = components["schemas"]["LocalIndexFile"];

export interface LocalMatch {
  file: LocalFile;
  score: number;
  nameRanges: [number, number][];
  folderRanges: [number, number][];
}

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

// Prefers the item whose matched characters all sit in the file name.
const byNameMatch: Tiebreaker<LocalFile> = (a, b, selector) => {
  const inName = (r: FzfResultItem<LocalFile>) => {
    const path = selector(r.item);
    const start = path.lastIndexOf("/") + 1;
    return [...r.positions].every((p) => p >= start);
  };
  return Number(inName(b)) - Number(inName(a));
};

// Merges sorted indices into half-open runs, shifted by `offset`.
function runs(indices: number[], offset: number): [number, number][] {
  const out: [number, number][] = [];
  for (const i of indices) {
    const at = i - offset;
    const last = out[out.length - 1];
    if (last && last[1] === at) last[1] = at + 1;
    else out.push([at, at + 1]);
  }
  return out;
}

export function searchLocalFiles(
  files: readonly LocalFile[],
  query: string,
): LocalMatch[] {
  if (query.trim() === "") return [];
  const fzf = new Fzf(files, {
    selector: (f) => f.path,
    match: extendedMatch,
    casing: "case-insensitive",
    tiebreakers: [byNameMatch, byLengthAsc],
  });
  return fzf.find(query).map((r) => {
    const nameStart = r.item.path.lastIndexOf("/") + 1;
    const sorted = [...r.positions].sort((a, b) => a - b);
    return {
      file: r.item,
      score: r.score,
      nameRanges: runs(
        sorted.filter((p) => p >= nameStart),
        nameStart,
      ),
      folderRanges: runs(
        sorted.filter((p) => p < nameStart - 1),
        0,
      ),
    };
  });
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
