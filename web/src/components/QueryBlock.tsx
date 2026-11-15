// pattern: Imperative Shell
// A {{query}} block. Its results UI (tables, cards, the cell editor) loads
// on the first query rendered, mirroring PdfEmbed's viewer, so pages
// without a query never pay for it in the entry chunk.
import { useEffect, useState, type ComponentType } from "react";
import type { MacroOptions } from "../grammar/macroOptions";
import type { QueryResultsProps } from "./QueryResults";

// A query whose results contain another {{query}} (e.g. a self-matching
// block) would otherwise re-mount an identical QueryBlock and recurse
// forever, fetch after fetch. Same guard idea as BlockRef's MAX_DEPTH.
const MAX_DEPTH = 2;

const NO_OPTIONS: MacroOptions = {};

let resultsPromise: Promise<ComponentType<QueryResultsProps>> | null = null;

function loadResults(): Promise<ComponentType<QueryResultsProps>> {
  if (!resultsPromise) {
    resultsPromise = import("./QueryResults").then((m) => m.QueryResults);
    // A failed chunk load shouldn't wedge every future query.
    resultsPromise.catch(() => { resultsPromise = null; });
  }
  return resultsPromise;
}

type Loaded =
  | { status: "loading" }
  | { status: "ok"; Results: ComponentType<QueryResultsProps> }
  | { status: "error"; message: string };

export function QueryBlock({ expr, options = NO_OPTIONS, depth = 0 }: {
  expr: string;
  options?: MacroOptions;
  depth?: number;
}) {
  const capped = depth >= MAX_DEPTH;
  const [loaded, setLoaded] = useState<Loaded>({ status: "loading" });
  useEffect(() => {
    if (capped) return;
    let live = true;
    loadResults().then(
      (Results) => { if (live) setLoaded({ status: "ok", Results }); },
      (e: unknown) => { if (live) setLoaded({ status: "error", message: String(e) }); });
    return () => { live = false; };
  }, [capped]);

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
  const { Results } = loaded;
  return <Results key={expr} expr={expr} options={options} depth={depth} />;
}
