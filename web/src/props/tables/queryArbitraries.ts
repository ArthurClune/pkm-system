// pattern: Functional Core
// What the query view property draws: the macro's options, a first records
// answer, and the steps one mounted query block sees: the reader's view
// changes, Reset and Save, cell edits, refetches and edits of the macro,
// and resyncs whose records and /api/query answers land or fail later.
// A record holds a drawn subset of the attribute keys, so a refetch often
// drops a key the last answer had, and now and then holds no `::` line at
// all, which makes blocks the default. A key differs from its label, as a
// canonical title does, so a column found by label alone misses its cells.
import fc from "fast-check";
import type {
  KeyStat, QueryRecordModel, QueryRecordsPayload, RecordCell,
} from "../../api/payloads";
import type { MacroOptions } from "../../grammar/macroOptions";
import { canonicalTitleOf, pageIdOf, uidOf } from "../../test-mint";
import type { ViewEvent } from "../../tables/viewState";

export const LABELS = ["Author", "Published", "Format"] as const;
const IDS = ["r1", "r2", "r3", "r4"] as const;
const VALUES = ["x", "y"] as const;
const FILTERS = ["", "x", "-author:x"] as const;

const keyOf = (label: string): string => label.toLowerCase();

function cellOf(id: string, label: string, value: string): RecordCell {
  const text = `${label}:: ${value}`;
  return { uid: uidOf(`cell-${id}-${keyOf(label)}`), key_raw: label, text, value,
           value_start: label.length + 2 };
}

export function recordOf(id: string, cells: readonly (readonly [string, string])[]):
    QueryRecordModel {
  return {
    key: id, kind: "page", page_id: pageIdOf(1),
    page_title: canonicalTitleOf(`Page ${id}`), uid: null, row_title: id,
    result_uids: [uidOf(`result-${id}`)],
    cells: Object.fromEntries(cells.map(([label, value]) =>
      [keyOf(label), cellOf(id, label, value)])),
    insert_parent_uid: null, insert_before_order_idx: null,
    last_attr_order_idx: null,
  };
}

/** As the server answers: key stats ranked by how many records hold them,
 * and the groups exactly when no record has a `::` cell. */
export function payloadOf(records: readonly QueryRecordModel[]): QueryRecordsPayload {
  const counts = new Map<string, number>();
  for (const r of records) {
    for (const cell of Object.values(r.cells)) {
      counts.set(cell.key_raw, (counts.get(cell.key_raw) ?? 0) + 1);
    }
  }
  const keys: KeyStat[] = [...counts].sort(([, a], [, b]) => b - a)
    .map(([label, count]) => ({ key: canonicalTitleOf(keyOf(label)), label, count }));
  const bare = records.every((r) => Object.keys(r.cells).length === 0);
  return { records: [...records], keys, total: records.length,
           groups: bare ? [] : null };
}

const cellsArb = fc.oneof(
  { weight: 4, arbitrary: fc.subarray([...LABELS]) },
  { weight: 1, arbitrary: fc.constant([] as string[]) },
).chain((labels) => fc.tuple(...labels.map((label) =>
  fc.constantFrom(...VALUES).map((v) => [label, v] as const))));

export const payloadArb: fc.Arbitrary<QueryRecordsPayload> = fc.oneof(
  { weight: 5, arbitrary: fc.shuffledSubarray([...IDS], { minLength: 1 }) },
  { weight: 1, arbitrary: fc.constant([] as string[]) },
).chain((ids) => fc.tuple(...ids.map((id) =>
  cellsArb.map((cells) => recordOf(id, cells)))))
  .map(payloadOf);

/** Bare records with no `::` line: an answer whose default is blocks. */
const barePayloadArb: fc.Arbitrary<QueryRecordsPayload> =
  fc.shuffledSubarray([...IDS], { minLength: 1 })
    .map((ids) => payloadOf(ids.map((id) => recordOf(id, []))));

export const optionsArb: fc.Arbitrary<MacroOptions> = fc.oneof(
  { weight: 4, arbitrary: fc.constant({}) },
  { weight: 1, arbitrary: fc.shuffledSubarray([...LABELS], { minLength: 1 })
      .map((columns) => ({ columns })) },
  { weight: 1, arbitrary: fc.constantFrom("table", "cards", "blocks")
      .map((view) => ({ view })) },
);

export type QueryStep =
  | Exclude<ViewEvent, { kind: "edited" } | { kind: "loaded" }>
  /** A cell write: the run steps the view with what is on screen. */
  | { kind: "edit" }
  /** A refetch with this answer. */
  | { kind: "load"; payload: QueryRecordsPayload }
  /** The macro's options, edited elsewhere. */
  | { kind: "macro"; options: MacroOptions }
  /** A resync whose records answer is still out. */
  | { kind: "resync" }
  /** The records answer still out lands, or fails when null. */
  | { kind: "answer"; payload: QueryRecordsPayload | null }
  /** The /api/query answer still out lands, or fails. */
  | { kind: "groups"; ok: boolean };

export const queryStepArb: fc.Arbitrary<QueryStep> = fc.oneof(
  { weight: 6, arbitrary: fc.constant({ kind: "edit" as const }) },
  { weight: 5, arbitrary: payloadArb.map((payload) => ({ kind: "load" as const, payload })) },
  { weight: 1, arbitrary: barePayloadArb.map((payload) => ({ kind: "load" as const, payload })) },
  { weight: 2, arbitrary: fc.constantFrom(...FILTERS).map((text) =>
      ({ kind: "filter" as const, text })) },
  { weight: 1, arbitrary: fc.constantFrom(...LABELS).map((col) =>
      ({ kind: "sortClick" as const, col })) },
  { weight: 1, arbitrary: fc.constantFrom("table", "cards", "blocks").map((view) =>
      ({ kind: "view" as const, view })) },
  { weight: 1, arbitrary: fc.shuffledSubarray([...LABELS], { minLength: 1 }).map(
      (columns) => ({ kind: "columns" as const, columns })) },
  { weight: 1, arbitrary: fc.constant({ kind: "reset" as const }) },
  { weight: 1, arbitrary: fc.constant({ kind: "saved" as const }) },
  { weight: 1, arbitrary: optionsArb.map((options) => ({ kind: "macro" as const, options })) },
  // A macro that moves the view off the table during a held edit.
  { weight: 1, arbitrary: fc.constantFrom("cards", "blocks").map((view) =>
      ({ kind: "macro" as const, options: { view } })) },
  { weight: 2, arbitrary: fc.constant({ kind: "resync" as const }) },
  // Into and out of the blocks view, which retries a failed fetch.
  { weight: 2, arbitrary: fc.constantFrom("table", "blocks").map((view) =>
      ({ kind: "view" as const, view })) },
  { weight: 3, arbitrary: fc.oneof(payloadArb, barePayloadArb, fc.constant(null))
      .map((payload) => ({ kind: "answer" as const, payload })) },
  { weight: 3, arbitrary: fc.oneof(
      { weight: 1, arbitrary: fc.constant(true) },
      { weight: 1, arbitrary: fc.constant(false) },
    ).map((ok) => ({ kind: "groups" as const, ok })) },
);

export interface QueryExample {
  readonly options: MacroOptions;
  readonly first: QueryRecordsPayload;
  readonly steps: readonly QueryStep[];
}

export const queryExampleArb: fc.Arbitrary<QueryExample> = fc.record({
  options: optionsArb,
  first: payloadArb,
  steps: fc.array(queryStepArb, { maxLength: 40, size: "max" }),
});
