// pattern: Imperative Shell
// A {{query}} block's results, loaded lazily by QueryBlock: its records as a
// table, cards or today's grouped blocks, with the filter, sort, view and
// columns the macro's options save. The records come first, since they
// decide the default view; the grouped blocks are fetched only once that
// view is shown. Cell writes and Save need the host block's edit access and
// a connection: queries are online-only.
import { Fragment, useCallback, useContext, useEffect, useRef,
         useState } from "react";
import { useNavigate } from "react-router";
import { OfflineError } from "../api/client";
import { apiGet } from "../api/typedClient";
import type { KeyStat, QueryGroup, QueryRecordModel } from "../api/payloads";
import { useStaleGuard } from "../useStaleGuard";
import type { MacroOptions, MacroView } from "../grammar/macroOptions";
import { formatMacroOptions,
         optionsRefusal } from "../grammar/macroOptionsWrite";
import { tokenizeBlock } from "../grammar/tokenize";
import { InlineSegments } from "./InlineSegments";
import { BlockEditContext, SidebarContext } from "../contexts";
import { pagePath } from "../paths";
import { useResync, useSyncHealth } from "../sync/SyncProvider";
import { QueryCards } from "../tables/QueryCards";
import { QueryTable } from "../tables/QueryTable";
import { planQuerySave, queryColumns, queryDefaults, shownRows,
         type QueryColumn } from "../tables/queryView";
import { island } from "../tables/island";
import { TableToolbar } from "../tables/TableToolbar";
import { useCellWrites } from "../tables/useCellWrites";
import { initialView, isDirty, optionsFromView, stepView,
         viewFromOptions, type ViewDefaults, type ViewEvent,
         type ViewState } from "../tables/viewState";
import { WriteNotice } from "../tables/WriteNotice";
import { MISSING_ANCESTOR_TEXT } from "./groups";
import { PageLink } from "./PageLink";

// query blocks are online-only
const errorText = (e: unknown): string =>
  e instanceof OfflineError ? "query unavailable offline" : String(e);

const VIEWS: { view: MacroView; label: string }[] = [
  { view: "blocks", label: "Blocks" },
  { view: "table", label: "Table" },
  { view: "cards", label: "Cards" },
];

interface Loaded {
  keys: KeyStat[];
  total: number;
  defaults: ViewDefaults;
}

export interface QueryResultsProps {
  expr: string;
  options: MacroOptions;
  depth: number;
}

export function QueryResults({ expr, options, depth }: QueryResultsProps) {
  const edit = useContext(BlockEditContext);
  const { status } = useSyncHealth();
  const canEdit = edit !== null && status === "connected";
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [records, setRecords] = useState<QueryRecordModel[]>([]);
  const [groups, setGroups] = useState<QueryGroup[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [groupsError, setGroupsError] = useState<string | null>(null);
  const [view, setView] = useState<ViewState | null>(null);
  const [saveRefusal, setSaveRefusal] =
    useState<{ live: ViewState["live"]; text: string } | null>(null);
  const [generation, setGeneration] = useState(0);
  useResync(useCallback(() => setGeneration((g) => g + 1), []));

  // Every load is stamped with a stale-response token. A response is applied
  // only if it is still current when it resolves; this drops stale responses
  // even when the offline gateway does not honor an AbortController.
  const recordsGuard = useStaleGuard();
  const groupsGuard = useStaleGuard();
  const groupsFor = useRef<string | null>(null);


  useEffect(() => {
    const token = recordsGuard.begin();
    void (async () => {
      try {
        const p = await apiGet("/api/query/records", { query: { expr } });
        if (recordsGuard.isStale(token)) return;
        setRecords(p.records);
        setLoaded({ keys: p.keys, total: p.total, defaults: queryDefaults(p) });
        setError(null);
      } catch (e: unknown) {
        if (!recordsGuard.isStale(token)) setError(errorText(e));
      }
    })();
  }, [expr, generation, recordsGuard]);

  // A refetch or an edit of the macro's options brings a new saved view;
  // one the reader has not touched follows it.
  useEffect(() => {
    if (loaded === null) return;
    const saved = viewFromOptions(options, loaded.defaults);
    setView((v) => v === null ? initialView(saved)
      : stepView(v, { kind: "loaded", saved }));
  }, [loaded, options]);

  const showsBlocks = view?.live.view === "blocks";
  useEffect(() => {
    const want = `${expr}\u0000${generation}`;
    if (!showsBlocks || groupsFor.current === want) return;
    const token = groupsGuard.begin();
    void (async () => {
      try {
        const p = await apiGet("/api/query", { query: { expr } });
        if (groupsGuard.isStale(token)) return;
        groupsFor.current = want;
        setGroups(p.groups);
        setGroupsError(null);
      } catch (e: unknown) {
        if (!groupsGuard.isStale(token)) setGroupsError(errorText(e));
      }
    })();
  }, [showsBlocks, expr, generation, groupsGuard]);

  const patch = useCallback((key: string,
                             fn: (r: QueryRecordModel) => QueryRecordModel) => {
    setRecords((rs) => rs.map((r) => (r.key === key ? fn(r) : r)));
  }, []);
  const writes = useCellWrites(patch);

  const step = (e: ViewEvent) => setView((v) => v && stepView(v, e));

  const header = (
    <div className="query-header">
      <span className="query-expr">query: {expr}</span>
      {view !== null && (
        <span className="query-views" role="group" aria-label="View" {...island}>
          {VIEWS.map(({ view: v, label }) => (
            <button key={v} type="button" aria-pressed={view.live.view === v}
                    className="btn-secondary btn-compact"
                    onClick={() => step({ kind: "view", view: v })}>{label}</button>
          ))}
        </span>
      )}
    </div>
  );

  if (loaded === null || view === null) {
    return (
      <div className="query-block">
        {header}
        {error && <p className="error">{error}</p>}
      </div>
    );
  }

  const live = view.live;
  const columns: QueryColumn[] = queryColumns(live.columns, loaded.keys);
  const { rows, matching } = shownRows(records, columns, live, view.frozen);
  const next = optionsFromView(live, loaded.defaults);
  const refusal = optionsRefusal(next)
    ?? (saveRefusal?.live === live ? saveRefusal.text : null);

  const save = () => {
    if (edit === null) return;
    const plan = planQuerySave(edit.text, expr, options, next);
    if ("refusal" in plan) {
      setSaveRefusal({ live, text: plan.refusal });
      return;
    }
    edit.setText(plan.text);
    step({ kind: "saved" });
  };

  const onWrite = (r: QueryRecordModel, c: QueryColumn, value: string) => {
    if (writes.write(r, c, value)) {
      step({ kind: "edited", visibleIds: rows.map((row) => row.record.key) });
    }
  };

  return (
    <div className="query-block">
      {header}
      {error && <p className="error">{error}</p>}
      {groupsError && live.view === "blocks"
        && <p className="error">{groupsError}</p>}
      <TableToolbar filter={live.filter}
                    onFilter={(text) => step({ kind: "filter", text })}
                    count={`${matching} of ${loaded.total} results`}
                    dirty={isDirty(view)}
                    saved={formatMacroOptions(options) !== ""}
                    canSave refusal={refusal}
                    onReset={() => step({ kind: "reset" })}
                    onSave={canEdit ? save : undefined}
                    onEditAsText={edit?.editAsText} />
      {writes.notice && (
        <div ref={writes.noticeRef}>
          <WriteNotice key={writes.notice.id} message={writes.notice.message}
                       onUndo={writes.notice.undo}
                       onDismiss={writes.dismiss} />
        </div>
      )}
      {/* Results are other blocks' text: nothing in them acts on the host. */}
      <BlockEditContext.Provider value={null}>
        {live.view === "table" && (
          <QueryTable rows={rows} columns={columns} keys={loaded.keys}
                      records={records} sort={live.sort}
                      onSortClick={(col) => step({ kind: "sortClick", col })}
                      canEdit={canEdit} onWrite={onWrite}
                      onColumns={(labels) => step({ kind: "columns", columns: labels })}
                      depth={depth + 1} />
        )}
        {live.view === "cards" && (
          <QueryCards rows={rows} columns={columns} depth={depth + 1} />
        )}
        {live.view === "blocks" && groups !== null && (
          <QueryGroups groups={groups} depth={depth}
                       shown={live.filter.trim() === "" ? null
                         : new Set(rows.flatMap((r) => r.record.result_uids))} />
        )}
      </BlockEditContext.Provider>
    </div>
  );
}

/** Today's grouped results; `shown`, when set, keeps only these results. */
function QueryGroups({ groups, shown, depth }: {
  groups: QueryGroup[];
  shown: ReadonlySet<string> | null;
  depth: number;
}) {
  const navigate = useNavigate();
  const { openInSidebar } = useContext(SidebarContext);
  return groups.map((g) => {
    const items = shown === null ? g.items
      : g.items.filter((item) => shown.has(item.uid));
    if (items.length === 0 && shown !== null) return null;
    return (
      <div className="query-group" key={g.page_id}>
        <div className="group-title"><PageLink title={g.page_title} tag={false} /></div>
        {items.map((item) => (
          <div className="query-item" key={item.uid}>
            {item.ancestors && item.ancestors.length > 0 && (
              <div className="breadcrumbs">
                {item.ancestors.map((at, i) => {
                  const uid = g.ancestor_uids?.[at];
                  const text = g.ancestor_texts?.[at] ?? MISSING_ANCESTOR_TEXT;
                  const href = `${pagePath(g.page_title)}#${uid ?? ""}`;
                  return (
                    <Fragment key={i}>
                      {i > 0 && " › "}
                      <a className="query-crumb" href={href}
                         onClick={(e) => {
                           e.preventDefault();
                           e.stopPropagation();
                           if (e.shiftKey && uid) openInSidebar(g.page_title, uid);
                           else void navigate(href);
                         }}>{text}</a>
                    </Fragment>
                  );
                })}
              </div>
            )}
            <InlineSegments segments={tokenizeBlock(item.text)} depth={depth + 1} />
          </div>
        ))}
      </div>
    );
  });
}
