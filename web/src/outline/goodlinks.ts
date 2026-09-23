// pattern: Functional Core
// The /goodlinks slash command's pure half: which URLs near a block are
// worth asking GoodLinks about (this block, its parent, its previous
// sibling, in that order), the attribute text the command inserts, and the
// notice for each failure. useOutline does the network and the splice.
import type { BlockNode } from "../api/payloads";
import { locate } from "./tree";

const URL_RE = /https?:\/\/[^\s<>()[\]]+/g;

function urlsIn(text: string): string[] {
  return (text.match(URL_RE) ?? []).map((u) => u.replace(/[.,;:!?]+$/, ""));
}

export function goodlinksCandidates(blocks: BlockNode[], uid: string): string[] {
  const loc = locate(blocks, uid);
  if (!loc) return [];
  const previous = loc.index > 0 ? loc.siblings[loc.index - 1] : null;
  const sources = [loc.node.text, loc.parent?.text ?? "", previous?.text ?? ""];
  const out: string[] = [];
  for (const text of sources) {
    for (const url of urlsIn(text)) {
      if (!out.includes(url)) out.push(url);
    }
  }
  return out;
}

export function goodlinksAttribute(id: string): string {
  return `Local copy:: [Goodlinks](/api/goodlinks/${id})`;
}

export function goodlinksNotice(status: number): string {
  if (status === 503) return "Goodlinks is not running";
  if (status === 422) return "Goodlinks refused the URL";
  if (status === 404) return "Not in Goodlinks";
  if (status === 0) return "Couldn't reach the server";
  return "Couldn't reach Goodlinks";
}
