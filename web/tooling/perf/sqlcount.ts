// pattern: Mixed (unavoidable)
// The counter is a thin hook around the pure classifiers (plannable, aliases,
// fullScans), which are ported from the backend check's sqlplan module; the
// hook itself reads and writes the live sqlite-wasm connection.
//
// SQLITE_TRACE_STMT reports each top-level statement's SQL; statements run by
// triggers (and FTS5 internals) arrive with a leading "--", mirroring the
// backend tracer, and are tallied separately. A firing trigger reports a
// "-- TRIGGER <name>" line and then one "-- <body statement>" line per body
// statement, each counted.

export const PROGRESS_N = 1000;

export interface SqlCounts {
  statements: number;
  trigger_statements: number;
  vm_steps_k: number;
  full_scans: number;
}

const PLANNABLE = ["SELECT", "INSERT", "UPDATE", "DELETE", "WITH", "REPLACE"];

// Words that can follow an unaliased table name; never an alias.
const NOT_ALIAS = [
  "WHERE", "ON", "USING", "JOIN", "LEFT", "RIGHT", "FULL", "INNER", "OUTER",
  "CROSS", "NATURAL", "GROUP", "ORDER", "LIMIT", "HAVING", "WINDOW", "UNION",
  "EXCEPT", "INTERSECT", "INDEXED", "NOT", "RETURNING", "SET", "VALUES",
  "AND", "OR", "WHEN", "THEN", "ELSE", "END", "AS",
];

// The alias word is only consumed when it is not one of NOT_ALIAS: otherwise
// an unaliased table directly followed by JOIN (`FROM blocks JOIN pages p`)
// would swallow "JOIN" as a bogus alias and drop the real alias after it.
const ALIASED = new RegExp(
  `\\b(?:FROM|JOIN)\\s+(\\w+)(?:\\s+AS\\s+(\\w+)|\\s+(?!(?:${[...NOT_ALIAS].sort().join("|")})\\b)(\\w+))?`,
  "gi");

export function plannable(sql: string): boolean {
  const head = sql.trimStart().toUpperCase();
  return PLANNABLE.some((p) => head.startsWith(p));
}

/** alias -> name for `FROM t a` / `JOIN t AS a` in one statement.
 * EXPLAIN QUERY PLAN names an aliased table by its alias (`SCAN b`). */
export function aliases(sql: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of sql.matchAll(ALIASED)) {
    const alias = m[2] ?? m[3];
    if (alias && m[1]) out.set(alias, m[1]);
  }
  return out;
}

/** Plan rows that read a real table with no index. CTEs, constant rows and
 * FTS virtual tables are not table scans in the sense that matters. `names`
 * resolves aliases; a CTE alias resolves to the CTE, which is not in `tables`. */
export function fullScans(
  details: readonly string[],
  tables: ReadonlySet<string>,
  names: ReadonlyMap<string, string> = new Map(),
): string[] {
  const out: string[] = [];
  for (const d of details) {
    if (!d.startsWith("SCAN ") || d.includes(" USING ") || d.includes("VIRTUAL TABLE")) continue;
    const name = d.split(/\s+/)[1] ?? "";
    if (tables.has(names.get(name) ?? name)) out.push(d);
  }
  return out;
}

export interface Oo1Exec {
  exec(opts: { sql: string; rowMode?: "array"; returnValue: "resultRows" }): unknown[];
  exec(sql: string): unknown;
}

/** The slice of sqlite-wasm's `capi` the counter calls. */
export interface Sqlite3Like {
  capi: {
    SQLITE_TRACE_STMT: number;
    sqlite3_trace_v2(
      db: number, mask: number,
      cb: ((reason: number, cbArg: number, p: number, x: number) => number) | number,
      ctx: number): number;
    sqlite3_progress_handler(db: number, nOps: number, cb: (() => number) | number, ctx: number): void;
  };
  wasm: { cstrToJs(ptr: number): string };
}

export interface Counter {
  measure<T>(fn: () => T | Promise<T>): Promise<{ result: T; counts: SqlCounts }>;
  uninstall(): void;
}

export function installCounter(sqlite3: Sqlite3Like, raw: { pointer: number } & Oo1Exec): Counter {
  const { capi, wasm } = sqlite3;
  let active = false;
  let statements = 0;
  let triggers = 0;
  let ticks = 0;
  let traced = new Set<string>();

  capi.sqlite3_trace_v2(raw.pointer, capi.SQLITE_TRACE_STMT, (reason, _db, _stmt, x) => {
    if (!active || reason !== capi.SQLITE_TRACE_STMT) return 0;
    const sql = wasm.cstrToJs(x);
    if (sql.trimStart().startsWith("--")) triggers += 1;
    else {
      statements += 1;
      traced.add(sql);
    }
    return 0;
  }, 0);
  capi.sqlite3_progress_handler(raw.pointer, PROGRESS_N, () => {
    if (active) ticks += 1;
    return 0;
  }, 0);

  const rows = (sql: string): unknown[][] =>
    raw.exec({ sql, rowMode: "array", returnValue: "resultRows" }) as unknown[][];

  function countFullScans(sqls: Iterable<string>): number {
    const tables = new Set(
      rows("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
        .filter((r) => !String(r[1]).trimStart().toUpperCase().startsWith("CREATE VIRTUAL TABLE"))
        .map((r) => String(r[0])));
    let n = 0;
    for (const sql of sqls) {
      if (!plannable(sql)) continue;
      // Throws for a statement that cannot be planned: that is not zero scans.
      const details = rows(`EXPLAIN QUERY PLAN ${sql}`).map((r) => String(r[3]));
      n += fullScans(details, tables, aliases(sql)).length;
    }
    return n;
  }

  return {
    async measure<T>(fn: () => T | Promise<T>) {
      statements = triggers = ticks = 0;
      traced = new Set();
      active = true;
      let result: T;
      try {
        result = await fn();
      } finally {
        active = false;
      }
      const full_scans = countFullScans(traced);
      return {
        result,
        counts: { statements, trigger_statements: triggers, vm_steps_k: ticks, full_scans },
      };
    },
    uninstall() {
      capi.sqlite3_trace_v2(raw.pointer, 0, 0, 0);
      capi.sqlite3_progress_handler(raw.pointer, 0, 0, 0);
    },
  };
}
