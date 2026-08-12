// pattern: Imperative Shell
import { useCallback, useEffect, useRef, useState } from "react";
import { apiDelete, apiGet, apiPost } from "../api/typedClient";
import type { AssetSearchItem } from "../api/payloads";
import { useConfirm } from "../components/ConfirmDialog";
import { ImageOverlay } from "../components/ImageOverlay";
import { SearchIcon } from "../components/icons";
import { useSync } from "../sync/SyncProvider";
import {
  FileDescriptionPopover, FileRefsPopover,
} from "./FileCardPopovers";
import {
  EMPTY_FILTERS, clipboardToken, deleteConfirm, formatSize,
  mimeCategory, searchQuery, summarizeDeletes,
} from "./filesCore";
import type { FileFilters } from "./filesCore";

// Stale-response guard: any Files list operation (reload, loadMore,
// selectAll) may take time to resolve. reload() bumps the generation on
// every filter change or explicit refresh; loadMore/selectAll capture the
// generation before they start and check it before committing a result, so
// a response that lands after a newer generation started is discarded
// instead of mixing result sets, overwriting totals, or selecting files
// outside the now-visible filter.
function bumpGeneration(gen: { current: number }): number {
  return ++gen.current;
}

function isStale(gen: { current: number }, at: number): boolean {
  return gen.current !== at;
}

function submitExportForm(sha256s: string[]) {
  const form = document.createElement("form");
  form.method = "post";
  form.action = "/api/assets/export.zip";
  form.style.display = "none";
  for (const sha of sha256s) {
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = "sha256s";
    input.value = sha;
    form.appendChild(input);
  }
  document.body.appendChild(form);
  form.submit();
  form.remove();
}

function FileCard({ item, checked, onToggle, onCopy }: {
  item: AssetSearchItem;
  checked: boolean;
  onToggle: () => void;
  onCopy: () => void;
}) {
  const category = mimeCategory(item.mime);
  const [broken, setBroken] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [popover, setPopover] = useState<
    { kind: "refs" | "status"; x: number; y: number } | null>(null);
  const thumbRef = useRef<HTMLButtonElement>(null);
  const closeOverlay = useCallback(() => setExpanded(false), []);
  const overlayError = useCallback(() => {
    setExpanded(false);
    setBroken(true);
  }, []);
  const when = item.created_at
    ? ` · ${new Date(item.created_at).toLocaleDateString()}` : "";
  return (
    <div className={"file-card" + (checked ? " selected" : "")}>
      {category === "image" && !broken ? (
        <button type="button" className="file-thumb" ref={thumbRef}
                aria-label={`Expand image: ${item.filename}`}
                onClick={() => setExpanded(true)}>
          <img src={item.url} alt={item.filename} loading="lazy"
               onError={() => setBroken(true)} />
        </button>
      ) : (
        <a className="file-thumb" href={item.url} target="_blank"
           rel="noreferrer">
          <span className="file-type-label">{category}</span>
        </a>
      )}
      {expanded && (
        <ImageOverlay src={item.url} alt={item.filename}
                      onClose={closeOverlay} onError={overlayError}
                      triggerRef={thumbRef} />
      )}
      {popover?.kind === "refs" && (
        <FileRefsPopover refs={item.refs} x={popover.x} y={popover.y}
                         onClose={() => setPopover(null)} />
      )}
      {popover?.kind === "status" && (
        <FileDescriptionPopover
          label={item.status === "failed"
            ? "Description error" : "Description"}
          text={(item.status === "failed"
            ? item.describe_error : item.description) ?? ""}
          x={popover.x} y={popover.y}
          onClose={() => setPopover(null)} />
      )}
      <span className="file-name" title={item.filename}>
        {item.filename}
      </span>
      <span className="file-sub">{formatSize(item.size)}{when}</span>
      <span className="file-badges">
        {item.status === "pending" ? (
          <span className="file-badge status-pending">pending</span>
        ) : (
          <button type="button"
                  className={`file-badge status-${item.status}`}
                  title={item.describe_error ?? undefined}
                  onClick={(e) => setPopover(
                    { kind: "status", x: e.clientX, y: e.clientY })}>
            {item.status}
          </button>
        )}
        {item.refs.length ? (
          <button type="button" className="file-badge linked"
                  onClick={(e) => setPopover(
                    { kind: "refs", x: e.clientX, y: e.clientY })}>
            {`${item.refs.length} ref${item.refs.length === 1 ? "" : "s"}`}
          </button>
        ) : (
          <span className="file-badge orphan">orphan</span>
        )}
      </span>
      {item.refs.length === 0 && (
        <button type="button" className="btn-secondary file-copy"
                onClick={onCopy}>
          Copy link
        </button>
      )}
      <label className="file-select">
        <input type="checkbox" checked={checked} onChange={onToggle}
               aria-label={`Select ${item.filename}`} />
      </label>
    </div>
  );
}

export function Files() {
  const { status } = useSync();
  const offline = status !== "connected";
  const { confirm, dialog } = useConfirm();
  const [filters, setFilters] = useState<FileFilters>(EMPTY_FILTERS);
  const [items, setItems] = useState<AssetSearchItem[]>([]);
  const [total, setTotal] = useState(0);
  const [state, setState] =
    useState<"loading" | "ready" | "error">("loading");
  const [selected, setSelected] =
    useState<ReadonlySet<string>>(new Set());
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const loadMoreInFlight = useRef(false);
  const [loadingMore, setLoadingMore] = useState(false);
  // Stale-response guard: only the latest reload may set state.
  const generation = useRef(0);

  const fetchPage = useCallback(
    (f: FileFilters, offset: number) =>
      apiGet("/api/assets/search", { query: searchQuery(f, offset) }),
    []);

  const reload = useCallback((f: FileFilters) => {
    const gen = bumpGeneration(generation);
    setState("loading");
    fetchPage(f, 0)
      .then((p) => {
        if (isStale(generation, gen)) return;
        setItems(p.assets);
        setTotal(p.total);
        setSelected(new Set());
        setState("ready");
      })
      .catch(() => {
        if (!isStale(generation, gen)) setState("error");
      });
  }, [fetchPage]);

  useEffect(() => {
    if (offline) return;
    const t = setTimeout(() => reload(filters), 250);
    return () => clearTimeout(t);
  }, [filters, offline, reload]);

  const update = (patch: Partial<FileFilters>) =>
    setFilters((f) => ({ ...f, ...patch }));

  const loadMore = async () => {
    if (loadMoreInFlight.current) return;
    loadMoreInFlight.current = true;
    setLoadingMore(true);
    const gen = generation.current;
    try {
      const p = await fetchPage(filters, items.length);
      if (isStale(generation, gen)) return;
      setItems((cur) => [...cur, ...p.assets]);
      setTotal(p.total);
    } catch {
      if (!isStale(generation, gen)) setNotice("Could not load more files.");
    } finally {
      loadMoreInFlight.current = false;
      setLoadingMore(false);
    }
  };

  const selectAll = async () => {
    const gen = generation.current;
    setBusy(true);
    try {
      let all = items;
      while (all.length < total) {
        const p = await fetchPage(filters, all.length);
        if (isStale(generation, gen)) return;
        if (p.assets.length === 0) break;
        all = [...all, ...p.assets];
      }
      if (isStale(generation, gen)) return;
      setItems(all);
      setSelected(new Set(all.map((i) => i.sha256)));
    } catch {
      if (!isStale(generation, gen)) {
        setNotice("Could not load the full selection.");
      }
    } finally {
      // busy is a UI lock on this operation, not fetched data — release it
      // even when the result itself was discarded as stale.
      setBusy(false);
    }
  };

  const toggle = (sha: string) =>
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(sha)) next.delete(sha); else next.add(sha);
      return next;
    });

  const deleteSelected = async () => {
    const chosen = items.filter((i) => selected.has(i.sha256));
    const { message, loud } = deleteConfirm(chosen);
    const ok = await confirm(message, {
      danger: true,
      title: loud ? "Delete linked files" : "Delete files",
      confirmLabel: `Delete ${chosen.length === 1 ? "file" : "files"}`,
    });
    if (!ok) return;
    setBusy(true);
    const failures: string[] = [];
    let deleted = 0;
    for (const item of chosen) {
      try {
        await apiDelete("/api/assets/{sha256}", {
          path: { sha256: item.sha256 },
        });
        deleted += 1;
      } catch {
        failures.push(item.filename);
      }
    }
    setBusy(false);
    setNotice(summarizeDeletes(deleted, failures));
    reload(filters);
  };

  const copyLink = async (item: AssetSearchItem) => {
    await navigator.clipboard.writeText(clipboardToken(item));
    setNotice("Link copied.");
  };

  const runScan = async () => {
    try {
      const p = await apiPost("/api/assets/scan");
      setNotice(p.enabled
        ? `Scan queued ${p.queued} file${p.queued === 1 ? "" : "s"}.`
        : `Image descriptions are disabled — ${p.reason}`);
    } catch {
      setNotice("Scan failed.");
    }
    reload(filters);
  };

  if (offline) {
    return (
      <article className="files-page">
        <h1 className="page-title">Files</h1>
        <p className="settings-note">
          Files needs a connection — reconnect to browse attachments.
        </p>
      </article>
    );
  }

  return (
    <article className="files-page">
      <h1 className="page-title">Files</h1>
      <div className="files-filters">
        <div className="search-field files-search">
          <span className="search-field-icon"><SearchIcon /></span>
          <input type="search" className="search-field-input"
                 value={filters.q} placeholder="Search files"
                 aria-label="Search files"
                 onChange={(e) => update({ q: e.target.value })} />
        </div>
        <label>Type{" "}
          <select className="input-control" value={filters.type}
                  aria-label="Type"
                  onChange={(e) => update({
                    type: e.target.value as FileFilters["type"] })}>
            <option value="">All</option>
            <option value="image">Images</option>
            <option value="pdf">PDFs</option>
            <option value="document">Documents</option>
            <option value="other">Other</option>
          </select>
        </label>
        <label>From{" "}
          <input type="date" className="input-control"
                 value={filters.fromDate} aria-label="From"
                 onChange={(e) => update({ fromDate: e.target.value })} />
        </label>
        <label>To{" "}
          <input type="date" className="input-control"
                 value={filters.toDate} aria-label="To"
                 onChange={(e) => update({ toDate: e.target.value })} />
        </label>
        <label>Linked{" "}
          <select className="input-control" value={filters.linked}
                  aria-label="Linked"
                  onChange={(e) => update({
                    linked: e.target.value as FileFilters["linked"] })}>
            <option value="all">All</option>
            <option value="linked">Linked</option>
            <option value="orphan">Orphans</option>
          </select>
        </label>
      </div>
      <div className="files-toolbar">
        <span className="files-count">
          {items.length} of {total} files
        </span>
        <button type="button" className="btn-secondary" disabled={busy}
                onClick={() => void selectAll()}>
          Select all
        </button>
        {selected.size > 0 && (
          <>
            <span className="files-count">{selected.size} selected</span>
            <button type="button" className="btn-secondary" disabled={busy}
                    onClick={() =>
                      submitExportForm([...selected])}>
              Export
            </button>
            <button type="button" className="btn-danger" disabled={busy}
                    onClick={() => void deleteSelected()}>
              Delete
            </button>
          </>
        )}
        <button type="button" className="btn-secondary" disabled={busy}
                onClick={() => void runScan()}>
          Scan for undescribed files
        </button>
        <button type="button" className="btn-secondary" disabled={busy}
                onClick={() => reload(filters)}>
          Refresh
        </button>
      </div>
      {notice && <p className="settings-note files-notice">{notice}</p>}
      {state === "loading" && <p className="settings-note">Loading…</p>}
      {state === "error" && (
        <p className="settings-note">Could not load files.</p>
      )}
      {state === "ready" && items.length === 0 && (
        <p className="settings-note">No files match these filters.</p>
      )}
      {state === "ready" && items.length > 0 && (
        <div className="files-grid">
          {items.map((item) => (
            <FileCard key={item.sha256} item={item}
                      checked={selected.has(item.sha256)}
                      onToggle={() => toggle(item.sha256)}
                      onCopy={() => void copyLink(item)} />
          ))}
        </div>
      )}
      {state === "ready" && items.length < total && (
        <button type="button" className="btn-secondary files-more"
                disabled={busy || loadingMore}
                onClick={() => void loadMore()}>
          Load more
        </button>
      )}
      {dialog}
    </article>
  );
}
