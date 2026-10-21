// pattern: Functional Core
// The /link-local-file picker's fzf search with highlight ranges. Kept apart
// from localFiles.ts, which the outline imports, so fzf stays out of the
// entry chunk. fzf matches over the NFC form of each item, so the positions
// (and the ranges built from them) index the NFC path; the picker renders
// the NFC name and folder for that reason.
import {
  Fzf,
  byLengthAsc,
  extendedMatch,
  type FzfResultItem,
  type Tiebreaker,
} from "fzf";
import type { LocalFile } from "./localFiles";

export interface LocalMatch {
  file: LocalFile;
  score: number;
  nameRanges: [number, number][];
  folderRanges: [number, number][];
}

const nfcPath = (f: LocalFile) => f.path.normalize("NFC");

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
    selector: nfcPath,
    match: extendedMatch,
    casing: "case-insensitive",
    tiebreakers: [byNameMatch, byLengthAsc],
  });
  return fzf.find(query).map((r) => {
    const nameStart = nfcPath(r.item).lastIndexOf("/") + 1;
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

