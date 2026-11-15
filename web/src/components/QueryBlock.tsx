// pattern: Imperative Shell
// A {{query}} block. Its results UI (tables, cards, the cell editor) loads
// on the first query rendered, mirroring PdfEmbed's viewer, so pages
// without a query never pay for it in the entry chunk.
import type { MacroOptions } from "../grammar/macroOptions";
import { lazyLoader, useLazy } from "./lazyComponent";

// A query whose results contain another {{query}} (e.g. a self-matching
// block) would otherwise re-mount an identical QueryBlock and recurse
// forever, fetch after fetch. Same guard idea as BlockRef's MAX_DEPTH.
const MAX_DEPTH = 2;

const NO_OPTIONS: MacroOptions = {};

const loadResults = lazyLoader(() => import("./tablesChunk").then((m) => m.QueryResults));

export function QueryBlock({ expr, options = NO_OPTIONS, depth = 0 }: {
  expr: string;
  options?: MacroOptions;
  depth?: number;
}) {
  const capped = depth >= MAX_DEPTH;
  const loaded = useLazy(loadResults, capped);

  if (capped) {
    // Inert placeholder matching the pre-live fallback: no fetch, no results.
    return <span className="query-pending">{`{{query: ${expr}}}`}</span>;
  }
  if (loaded.status !== "ok") {
    return (
      <div className="query-block">
        <div className="query-header">
          <span className="query-expr">query: {expr}</span>
        </div>
        {loaded.status === "error" && <p className="error">{loaded.message}</p>}
      </div>
    );
  }
  // A new expression is a new query: its view and records start afresh.
  const Results = loaded.value;
  return <Results key={expr} expr={expr} options={options} depth={depth} />;
}
