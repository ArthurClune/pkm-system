// pattern: Imperative Shell
// A {{query}} block's results, loaded lazily by QueryBlock: its records as a
// table, cards or today's grouped blocks, with the filter, sort, view and
// columns the macro's options save. The records decide the default view, and
// when it is blocks they carry the grouped blocks too, so a query without
// `::` cells takes one request. Otherwise the blocks come from /api/query,
// started with the records when the macro saves the blocks view (until the
// reader picks another) and on demand when the reader picks it. Cell writes
// and Save need the host block's edit access and a connection: queries are
// online-only. While a cell edit holds the rows in place, a refetch that
// drops a held row's record keeps showing the record it last had
// (holdRecords), so a row an edit took out of the query stays put,
// writable, until the view changes; and a view or column list that follows
// the data's defaults stays as the first edit saw it (showQuery).
import { Fragment, useCallback, useContext, useEffect, useLayoutEffect,
         useRef, useState } from "react";
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
import { holdRecords, planQuerySave, queryDefaults,
         type QueryColumn } from "../tables/queryView";
import { editedEvent, initialQueryView, showQuery, stepQueryView,
         type QueryViewEvent,
         type QueryViewState } from "../tables/queryViewState";
import { island } from "../tables/island";
import { TableToolbar } from "../tables/TableToolbar";
import { useCellWrites } from "../tables/useCellWrites";
import { isDirty, optionsFromView, viewFromOptions, type ViewDefaults,
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

interface Records {
  records: QueryRecordModel[];
  /** Frozen rows' records the last refetch dropped, by key. */
  held: ReadonlyMap<string, QueryRecordModel>;
}

const loadKey = (expr: string, generation: number): string =>
  `${expr}\u0000${generation}`;

const NO_RECORDS: Records = { records: [], held: new Map() };

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
  const [{ records, held }, setRecords] = useState<Records>(NO_RECORDS);
  const [groups, setGroups] = useState<QueryGroup[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [groupsError, setGroupsError] = useState<string | null>(null);
  const [qv, setQv] = useState<QueryViewState | null>(null);
  const view = qv?.view ?? null;
  const [saveRefusal, setSaveRefusal] =
    useState<{ live: ViewState["live"]; text: string } | null>(null);
  const [generation, setGeneration] = useState(0);
  useResync(useCallback(() => setGeneration((g) => g + 1), []));

  // Every load is stamped with a stale-response token. A response is applied
  // only if it is still current when it resolves; this drops stale responses
  // even when the offline gateway does not honor an AbortController.
  const recordsGuard = useStaleGuard();
  const groupsGuard = useStaleGuard();
  // The load (`loadKey`) whose records last landed or failed: state, so
  // the groups effect reruns when they settle either way.
  const [recordsFor, setRecordsFor] = useState<string | null>(null);
  // The load the groups state answers.
  const groupsFor = useRef<string | null>(null);
  // The load a /api/query was last started for, kept after a failure so the
  // rerun when the records settle does not retry it away.
  const groupsTried = useRef<string | null>(null);
  // Read when a load lands, which must not wait on or rerun for the view.
  const frozenNow = useRef<readonly string[] | null>(null);
  useLayoutEffect(() => { frozenNow.current = view?.frozen ?? null; }, [view]);

  useEffect(() => {
    const token = recordsGuard.begin();
    const want = loadKey(expr, generation);
    void (async () => {
      try {
        const p = await apiGet("/api/query/records", { query: { expr } });
        if (recordsGuard.isStale(token)) return;
        setRecordsFor(want);
        if (p.groups !== null) {
          // These are as new as the records: drop a /api/query still in
          // flight for this load, which the groups effect will not repeat.
          groupsGuard.begin();
          groupsFor.current = want;
          setGroups(p.groups);
          setGroupsError(null);
        }
        const frozen = frozenNow.current;
        setRecords((cur) => ({
          records: p.records,
          held: holdRecords(cur.records, cur.held, p.records, frozen) }));
        setLoaded({ keys: p.keys, total: p.total, defaults: queryDefaults(p) });
        setError(null);
      } catch (e: unknown) {
        if (recordsGuard.isStale(token)) return;
        setRecordsFor(want);
        setError(errorText(e));
      }
    })();
  }, [expr, generation, recordsGuard, groupsGuard]);

  // A refetch or an edit of the macro's options brings a new saved view;
  // one the reader has not touched follows it.
  useEffect(() => {
    if (loaded === null) return;
    const saved = viewFromOptions(options, loaded.defaults);
    setQv((v) => v === null ? initialQueryView(saved)
      : stepQueryView(v, { kind: "loaded", saved }));
  }, [loaded, options]);

  const shown = loaded === null || qv === null ? null
    : showQuery(qv, options, loaded.keys, records, held);
  // What the last commit showed, for the edit a cell write steps the view
  // with. DataTable's unmount commit calls the onWrite of the render before
  // the change that unmounted it, which would freeze what is gone.
  const shownNow = useRef<Parameters<typeof editedEvent> | null>(null);
  useLayoutEffect(() => {
    shownNow.current = shown === null || loaded === null ? null
      : [shown, loaded.keys];
  });
  const savedBlocks = options.view === "blocks";
  const shownView = shown?.view ?? null;
  // The saved view counts until there is a shown one to follow.
  const wantsBlocks = shownView === null ? savedBlocks : shownView === "blocks";
  useEffect(() => {
    const want = loadKey(expr, generation);
    // Leaving the blocks view and returning retries a failed fetch.
    if (!wantsBlocks) groupsTried.current = null;
    if (groupsFor.current === want || groupsTried.current === want) return;
    // A saved blocks view fetches with the records; otherwise they decide,
    // since they may carry the groups themselves.
    if (!wantsBlocks || !(savedBlocks || recordsFor === want)) return;
    const token = groupsGuard.begin();
    groupsTried.current = want;
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
  }, [wantsBlocks, savedBlocks, recordsFor, expr, generation, groupsGuard]);

  const patch = useCallback((key: string,
                             fn: (r: QueryRecordModel) => QueryRecordModel) => {
    setRecords((cur) => {
      const was = cur.held.get(key);
      return {
        records: cur.records.map((r) => (r.key === key ? fn(r) : r)),
        held: was === undefined ? cur.held : new Map(cur.held).set(key, fn(was)),
      };
    });
  }, []);
  const writes = useCellWrites(patch);

  const step = (e: QueryViewEvent) => setQv((v) => v && stepQueryView(v, e));

  const header = (
    <div className="query-header">
      <span className="query-expr">query: {expr}</span>
      {shown !== null && (
        <span className="query-views" role="group" aria-label="View" {...island}>
          {VIEWS.map(({ view: v, label }) => (
            <button key={v} type="button" aria-pressed={shown.view === v}
                    className="btn-secondary btn-compact"
                    onClick={() => step({ kind: "view", view: v })}>{label}</button>
          ))}
        </span>
      )}
    </div>
  );

  if (loaded === null || view === null || shown === null) {
    return (
      <div className="query-block">
        {header}
        {error && <p className="error">{error}</p>}
      </div>
    );
  }

  const live = view.live;
  const { columns, rows, matching } = shown;
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
    // A refused write (an unsaved draft, a text limit) leaves the view
    // unsaved, so Reset and Save stay.
    if (plan.text === edit.text || edit.setText(plan.text)) step({ kind: "saved" });
  };

  const onWrite = (r: QueryRecordModel, c: QueryColumn, value: string) => {
    if (writes.write(r, c, value)) {
      const now = shownNow.current;
      if (now !== null) step(editedEvent(...now));
    }
  };

  return (
    <div className="query-block">
      {header}
      {error && <p className="error">{error}</p>}
      {groupsError && shown.view === "blocks"
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
        {shown.view === "table" && (
          <QueryTable rows={rows} columns={columns} keys={loaded.keys}
                      records={records} sort={live.sort}
                      onSortClick={(col) => step({ kind: "sortClick", col })}
                      canEdit={canEdit} onWrite={onWrite}
                      onColumns={(labels) => step({ kind: "columns", columns: labels })}
                      depth={depth + 1} />
        )}
        {shown.view === "cards" && (
          <QueryCards rows={rows} columns={columns} depth={depth + 1} />
        )}
        {shown.view === "blocks" && groups !== null && (
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
