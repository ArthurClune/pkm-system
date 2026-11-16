// pattern: Functional Core
// A plain {{table}} block's view: its columns named by the header row, its
// body rows filtered and sorted (the header stays first, and the blocks
// never move), and Save planned against the block's own text. A plain
// table saves only a filter and a sort: `view` and `columns` are query
// options.
import type { BlockNode } from "../api/payloads";
import { tokenizeBlock, type BlockSegment, type InlineSegment } from "../grammar/tokenize";
import { tableMacroOptions, type MacroOptions } from "../grammar/macroOptions";
import {
  formatMacroOptions, normaliseMacroOptions, optionsRefusal,
  rewriteMacroOptions,
} from "../grammar/macroOptionsWrite";
import type { RoamTableRows } from "../outline/roamTableRows";
import { viewRows, type Shown } from "./viewRows";
import { viewFromOptions, type ViewDefaults, type ViewFields } from "./viewState";

export const TABLE_DEFAULTS: ViewDefaults = { view: "table", columns: [] };

/** `key` names the column in a filter, a sort and the saved view: the
 * header's text, or `Column N` for an empty or repeated header. */
export interface TableColumn { key: string; header: BlockNode | null }

export function tableColumns(header: readonly (BlockNode | null)[]): TableColumn[] {
  const taken = new Set<string>();
  return header.map((cell, i) => {
    let key = cell?.text.trim() ?? "";
    if (key === "" || taken.has(key)) {
      key = `Column ${i + 1}`;
      while (taken.has(key)) key += "'";
    }
    taken.add(key);
    return { key, header: cell };
  });
}

/** A body row: `id` is its first cell's uid, `index` its place in the
 * table's rows (the header is 0). */
export interface TableRow { id: string; index: number; cells: (BlockNode | null)[] }

export function bodyRows(rows: RoamTableRows): TableRow[] {
  return rows.slice(1).map((cells, i) => ({ id: cells[0]!.uid, index: i + 1, cells }));
}

export function shownTableRows(
  body: readonly TableRow[], columns: readonly TableColumn[],
  live: ViewFields, frozen: readonly string[] | null,
): { rows: Shown<TableRow>[]; matching: number } {
  const keys = columns.map((c) => c.key);
  return viewRows(body, (r) => r.id,
    (r) => Object.fromEntries(keys.map((k, i) => [k, r.cells[i]?.text])),
    keys, live, frozen);
}

export function tableSavedView(o: MacroOptions): ViewFields {
  return viewFromOptions({ filter: o.filter, sort: o.sort }, TABLE_DEFAULTS);
}

const NOT_A_TABLE = "This block's text is no longer a table macro, so the "
  + "view was not saved. Use Edit as text.";
const NO_ROUND_TRIP = "This view would not read back from the block's text, "
  + "so it was not saved. Use Edit as text.";

/** `text`, a table block's whole text, with `next` as its macro's options.
 * The macro runs from the first non-blank `{{` to the `}}` that ends the
 * trimmed text (tableMacroOptions accepts no other), and the whitespace
 * around it is kept. */
export function planTableSave(text: string, next: MacroOptions):
    { text: string } | { refusal: string } {
  const refused = optionsRefusal(next);
  if (refused !== null) return { refusal: refused };
  if (tableMacroOptions(text) === null) return { refusal: NOT_A_TABLE };
  const span = [text.length - text.trimStart().length, text.trimEnd().length] as const;
  const written = rewriteMacroOptions(text, span, next);
  const back = tableMacroOptions(written);
  if (back === null
      || formatMacroOptions(back) !== formatMacroOptions(normaliseMacroOptions(next))) {
    return { refusal: NO_ROUND_TRIP };
  }
  return { text: written };
}

/** A header cell's segments with nothing interactive left in them, because
 * the header sits inside the sort button, where a link, a button or a
 * checkbox is invalid and would take the click. A block ref shows its
 * `((uid))` rather than the referenced text, which only a component can
 * look up; that is also what an unresolved ref renders. */
export function headerSegments(text: string): BlockSegment[] {
  return tokenizeBlock(text).flatMap((seg): BlockSegment[] => {
    switch (seg.kind) {
      case "todo":
        return [{ kind: "text", text: seg.done ? "[x]" : "[ ]" }];
      case "query":
        return [{ kind: "text", text: text.slice(seg.span[0], seg.span[1]) }];
      case "code-block":
        return [{ kind: "inline-code", code: seg.code }];
      case "pdf-embed":
        return [{ kind: "text", text: seg.href }];
      default:
        return inlineHeader(seg);
    }
  });
}

function inlineHeader(seg: InlineSegment): InlineSegment[] {
  switch (seg.kind) {
    case "page-ref":
      return [{ kind: "text", text: seg.tag ? `#${seg.title}` : seg.title }];
    case "attribute":
      return [{ kind: "text", text: seg.name }];
    case "block-ref":
      return [{ kind: "text", text: `((${seg.uid}))` }];
    case "link":
      return [{ kind: "text", text: seg.text }];
    case "asset-link":
      return [{ kind: "text", text: seg.filename }];
    case "image":
      return seg.alt === "" ? [] : [{ kind: "text", text: seg.alt }];
    case "bold": case "italic": case "strike": case "highlight":
      return [{ ...seg, children: seg.children.flatMap(inlineHeader) }];
    case "text": case "linebreak": case "inline-code": case "math":
      return [seg];
    default: {
      const exhaustive: never = seg;
      return exhaustive;
    }
  }
}
