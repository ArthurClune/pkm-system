// pattern: Imperative Shell
import { useCallback, useEffect, useRef, useState } from "react";
import { copyText } from "../copyText";
import type { Sha256Hex } from "../api/brands";
import { deleteRefusalBlockers } from "../api/client";
import { apiDelete, apiGet, apiPost } from "../api/typedClient";
import type { AssetSearchItem } from "../api/payloads";
import { useConfirm } from "../components/ConfirmDialog";
import { DeleteBlockedDialog } from "../components/DeleteBlockedDialog";
import type { DeleteBlocker } from "../components/deletePageCopy";
import { ImageOverlay } from "../components/ImageOverlay";
import { PdfEmbed } from "../components/PdfEmbed";
import { SearchIcon } from "../components/icons";
import { useSyncHealth } from "../sync/SyncProvider";
import { useReducerRef } from "../useReducerRef";
import {
  FileDescriptionPopover, FileRefsPopover,
} from "./FileCardPopovers";
import {
  EMPTY_FILTERS, blockedFilesHeading, clipboardToken, deleteConfirm,
  fileBlockerReasonLabel, formatSize, mimeCategory, searchQuery,
  summarizeDeletes,
} from "./filesCore";
import type { FileFilters } from "./filesCore";
import { filesPaging, initialFilesPaging } from "./filesPaging";

function submitExportForm(sha256s: Sha256Hex[]) {
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
  // Safari does not focus a button on click, so the modal had no focused
  // element to restore at open; refocus the thumb explicitly.
  const closePdf = useCallback(() => {
    setExpanded(false);
    thumbRef.current?.focus();
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
      ) : category === "pdf" ? (
        // In-app viewer on every surface: a same-origin navigation would
        // take over the iOS standalone PWA with no way back.
        <button type="button" className="file-thumb" ref={thumbRef}
                aria-label={`Open PDF: ${item.filename}`}
                onClick={() => setExpanded(true)}>
          <span className="file-type-label">{category}</span>
        </button>
      ) : (
        <a className="file-thumb" href={item.url} target="_blank"
           rel="noreferrer">
          <span className="file-type-label">{category}</span>
        </a>
      )}
      {expanded && category === "image" && (
        <ImageOverlay src={item.url} alt={item.filename}
                      onClose={closeOverlay} onError={overlayError}
                      triggerRef={thumbRef} />
      )}
      {expanded && category === "pdf" && (
        <PdfEmbed href={item.url} label={item.filename}
                  onClose={closePdf} />
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
        <button type="button" className="btn-secondary btn-compact file-copy"
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
  const { status } = useSyncHealth();
  const offline = status !== "connected";
  const { confirm, dialog } = useConfirm();
  const [filters, setFilters] = useState<FileFilters>(EMPTY_FILTERS);
  const { state: paging, current, dispatch } =
    useReducerRef(filesPaging, initialFilesPaging);
  const { items, total, phase, selected, notice } = paging;
  const busy = paging.busy !== null;
  // The blocks a refused delete names: the server strips a file's links
  // from block text, and refuses when that would break a block.
  const [blocked, setBlocked] = useState<
    { heading: string; blockers: DeleteBlocker[] } | null>(null);
  const closeBlocked = useCallback(() => setBlocked(null), []);

  const fetchPage = useCallback(
    (f: FileFilters, offset: number) =>
      apiGet("/api/assets/search", { query: searchQuery(f, offset) }),
    []);

  const reload = useCallback((f: FileFilters) => {
    const gen = dispatch({ type: "reloadStarted" }).filterGen;
    fetchPage(f, 0)
      .then((p) => dispatch({ type: "loaded", gen, items: p.assets,
                              total: p.total }))
      .catch(() => dispatch({ type: "failed", gen }));
  }, [dispatch, fetchPage]);

  useEffect(() => {
    if (offline) return;
    const t = setTimeout(() => reload(filters), 250);
    return () => clearTimeout(t);
  }, [filters, offline, reload]);

  const update = (patch: Partial<FileFilters>) => {
    dispatch({ type: "filterChanged" });
    setFilters((f) => ({ ...f, ...patch }));
  };

  // Each handler reads current(), not the render's state, and a refused
  // start comes back as the same object: a second click before the re-render
  // starts nothing.
  const loadMore = async () => {
    const before = current();
    const started = dispatch({ type: "moreStarted" });
    if (started === before) return;
    const gen = started.filterGen;
    try {
      const p = await fetchPage(filters, started.items.length);
      dispatch({ type: "moreLoaded", gen, items: p.assets, total: p.total });
    } catch {
      dispatch({ type: "moreFailed", gen });
    }
  };

  const selectAll = async () => {
    const before = current();
    const started = dispatch({ type: "selectAllStarted" });
    if (started === before) return;
    const gen = started.filterGen;
    try {
      let all = started.items;
      while (all.length < started.total && current().filterGen === gen) {
        const p = await fetchPage(filters, all.length);
        if (p.assets.length === 0) break;
        all = [...all, ...p.assets];
      }
      dispatch({ type: "selectAllLoaded", gen, items: all });
    } catch {
      dispatch({ type: "selectAllFailed", gen });
    }
  };

  const toggle = (sha: Sha256Hex) => dispatch({ type: "toggled", sha });

  const deleteSelected = async () => {
    const chosen = items.filter((i) => selected.has(i.sha256));
    const { message, loud } = deleteConfirm(chosen);
    const ok = await confirm(message, {
      danger: true,
      heading: loud ? "Delete linked files" : "Delete files",
      confirmLabel: `Delete ${chosen.length === 1 ? "file" : "files"}`,
    });
    if (!ok) return;
    dispatch({ type: "deleteStarted" });
    const failures: string[] = [];
    const blockedFiles: string[] = [];
    const blockers: DeleteBlocker[] = [];
    let deleted = 0;
    for (const item of chosen) {
      try {
        await apiDelete("/api/assets/{sha256}", {
          path: { sha256: item.sha256 },
        });
        deleted += 1;
      } catch (e) {
        failures.push(item.filename);
        const named = deleteRefusalBlockers(e);
        if (named !== null) {
          blockedFiles.push(item.filename);
          blockers.push(...named);
        }
      }
    }
    dispatch({ type: "deleteFinished",
               notice: summarizeDeletes(deleted, failures) });
    if (blockers.length > 0) {
      setBlocked({ heading: blockedFilesHeading(blockedFiles), blockers });
    }
    reload(filters);
  };

  const copyLink = async (item: AssetSearchItem) => {
    const token = clipboardToken(item);
    dispatch({ type: "noticeShown", text: await copyText(token)
      ? "Link copied."
      : `Copying failed. Select and copy it: ${token}` });
  };

  const runScan = async () => {
    try {
      const p = await apiPost("/api/assets/scan");
      dispatch({ type: "noticeShown", text: p.enabled
        ? `Scan queued ${p.queued} file${p.queued === 1 ? "" : "s"}.`
        : `Image descriptions are disabled — ${p.reason}` });
    } catch {
      dispatch({ type: "noticeShown", text: "Scan failed." });
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
                 value={filters.q} placeholder="Search names & descriptions"
                 aria-label="Search names & descriptions"
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
        <button type="button" className="btn-secondary"
                disabled={busy || phase !== "ready" || paging.more !== null}
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
      {phase === "loading" && <p className="settings-note">Loading…</p>}
      {phase === "error" && (
        <p className="settings-note">Could not load files.</p>
      )}
      {phase === "ready" && items.length === 0 && (
        <p className="settings-note">No files match these filters.</p>
      )}
      {phase === "ready" && items.length > 0 && (
        <div className="files-grid">
          {items.map((item) => (
            <FileCard key={item.sha256} item={item}
                      checked={selected.has(item.sha256)}
                      onToggle={() => toggle(item.sha256)}
                      onCopy={() => void copyLink(item)} />
          ))}
        </div>
      )}
      {phase === "ready" && items.length < total && (
        <button type="button" className="btn-secondary files-more"
                disabled={busy || paging.more !== null}
                onClick={() => void loadMore()}>
          Load more
        </button>
      )}
      {dialog}
      {blocked !== null && (
        <DeleteBlockedDialog heading={blocked.heading}
                             blockers={blocked.blockers}
                             label={fileBlockerReasonLabel}
                             onClose={closeBlocked} />
      )}
    </article>
  );
}
