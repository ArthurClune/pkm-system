// pattern: Functional Core
// The replica's row check: the same contract as the server's `row_problems`
// (server/src/pkm/rows.py) over the generated vocabulary in columns.gen.ts.
import { BRAND_SHAPES, COLUMN_META, type ColumnMeta } from "./columns.gen";

type Cell = string | number | null | Uint8Array | boolean | undefined;

// Built on first use so importing this module has no side effect and a
// bundle that never calls `rowProblems` can drop it.
let shapes: Map<string, RegExp> | null = null;
function shapeOf(brand: string): RegExp | undefined {
  if (shapes === null) {
    shapes = new Map();
    for (const [name, { pattern }] of Object.entries(BRAND_SHAPES)) {
      if (pattern !== null) shapes.set(name, new RegExp(`^(?:${pattern})$`));
    }
  }
  return shapes.get(brand);
}

function baseProblem(key: string, base: string, value: Cell): string | null {
  if (typeof value === "boolean") return `${key}: bool ${String(value)} is not ${base}`;
  const got = value instanceof Uint8Array ? "blob" : typeof value;
  const ok =
    base === "text" ? typeof value === "string"
    : base === "blob" ? value instanceof Uint8Array
    : typeof value === "number" && (base === "real" || Number.isInteger(value));
  return ok ? null : `${key}: expected ${base}, got ${got}`;
}

/** One message per column that is not a `Columns` key or whose value does
 * not fit its key; empty when the row is well formed. */
export function rowProblems(row: Record<string, Cell>): string[] {
  const problems: string[] = [];
  const metas = COLUMN_META as Record<string, ColumnMeta | undefined>;
  for (const [key, value] of Object.entries(row)) {
    const meta = metas[key];
    if (meta === undefined) {
      problems.push(`${key}: not a registered row key`);
      continue;
    }
    if (value === null || value === undefined) {
      if (!meta.nullable) problems.push(`${key}: NULL for a non-null key`);
      continue;
    }
    const bad = baseProblem(key, meta.base, value);
    if (bad !== null) {
      problems.push(bad);
      continue;
    }
    const { literals } = meta;
    if (literals !== null && !literals.includes(value as string | number)) {
      problems.push(
        `${key}: ${JSON.stringify(value)} is not one of `
        + `${literals.map((v) => JSON.stringify(v)).join(", ")}; `
        + "normalise it in the query or fix the data");
      continue;
    }
    const shape = meta.brand === null ? undefined : shapeOf(meta.brand);
    if (shape !== undefined && !shape.test(String(value))) {
      problems.push(`${key}: ${JSON.stringify(value)} is not a valid ${meta.brand}`);
    }
  }
  return problems;
}

/** The error text for a failed row check. */
export function rowCheckMessage(sql: string, problems: string[]): string {
  return `row check failed for '${sql.split(/\s+/).join(" ").trim()}': `
    + `${problems.join("; ")}. Fix the query: alias the column to a key of `
    + "Columns (the Python vocabulary in server/src/pkm/rows.py and "
    + "brand_registry.py, then `uv run python -m pkm.rows_dump`), COALESCE a "
    + "NULL aggregate or use a nullable key; never loosen rowProblems.";
}
