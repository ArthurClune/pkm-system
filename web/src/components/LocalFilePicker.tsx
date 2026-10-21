// pattern: Imperative Shell
// Picker for the /link-local-file command, portalled to body like
// ImageOverlay. One fetch of GET /api/local-index on mount, then either a
// folder browser (empty query) or fzf search over the whole tree. Keyboard
// handling stays on the search input because useOverlayDismiss pins Tab
// there; the list is a listbox driven by aria-activedescendant.
import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ApiError } from "../api/client";
import { apiGet } from "../api/typedClient";
import {
  fileName,
  folderListing,
  folderOf,
  searchLocalFiles,
  type LocalFile,
} from "../outline/localFiles";
import { useOverlayDismiss } from "./useOverlayDismiss";

type IndexState =
  | { status: "loading" }
  | { status: "ok"; files: LocalFile[] }
  | { status: "error"; message: string };

type Row =
  | { kind: "folder"; key: string; path: string; name: string }
  | { kind: "file"; key: string; file: LocalFile; nameRanges: [number, number][]; folderRanges: [number, number][] };

const SEPARATOR = " › ";

function failureMessage(err: unknown): string {
  if (err instanceof ApiError && err.status === 404) return "Local files aren't set up on this server";
  if (err instanceof ApiError && err.status === 503) return "Couldn't read the local files folder on the server";
  return "Couldn't reach the server";
}

// Wraps the half-open `ranges` of `text` in <mark>.
function highlighted(text: string, ranges: readonly [number, number][]): ReactNode {
  const out: ReactNode[] = [];
  let at = 0;
  for (const [start, end] of ranges) {
    if (start > at) out.push(text.slice(at, start));
    out.push(<mark key={start}>{text.slice(start, end)}</mark>);
    at = end;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

// Ranges index the `/`-joined folder path; the display joins segments with
// " › ", so each segment is rendered with its own clipped, shifted ranges.
function folderText(folder: string, ranges: readonly [number, number][]): ReactNode {
  let offset = 0;
  return folder.split("/").map((segment, i) => {
    const from = offset;
    const to = from + segment.length;
    offset = to + 1;
    const local = ranges
      .filter(([s, e]) => s < to && e > from)
      .map(([s, e]) => [Math.max(s, from) - from, Math.min(e, to) - from] as [number, number]);
    return (
      <Fragment key={i}>
        {i > 0 && SEPARATOR}
        {highlighted(segment, local)}
      </Fragment>
    );
  });
}

export function LocalFilePicker({ onPick, onClose }: {
  onPick: (file: LocalFile) => void;
  onClose: () => void;
}) {
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<IndexState>({ status: "loading" });
  const [query, setQuery] = useState("");
  const [folder, setFolder] = useState("");
  const [selected, setSelected] = useState(0);
  useOverlayDismiss(searchRef, onClose);

  useEffect(() => {
    let alive = true;
    apiGet("/api/local-index").then(
      (index) => { if (alive) setState({ status: "ok", files: index.files }); },
      (err: unknown) => { if (alive) setState({ status: "error", message: failureMessage(err) }); },
    );
    return () => { alive = false; };
  }, []);

  const files = state.status === "ok" ? state.files : null;
  const searching = query.trim() !== "";
  const matches = useMemo(() => (files && searching ? searchLocalFiles(files, query) : []), [files, searching, query]);
  const rows = useMemo<Row[]>(() => {
    if (!files) return [];
    if (searching) {
      return matches.map((m) => ({
        kind: "file", key: m.file.path, file: m.file, nameRanges: m.nameRanges, folderRanges: m.folderRanges,
      }));
    }
    const listing = folderListing(files, folder);
    const prefix = folder === "" ? "" : `${folder}/`;
    return [
      ...listing.folders.map((name): Row => ({
        kind: "folder", key: `d:${prefix}${name}`, path: `${prefix}${name}`, name,
      })),
      ...listing.files.map((file): Row => ({ kind: "file", key: file.path, file, nameRanges: [], folderRanges: [] })),
    ];
  }, [files, searching, matches, folder]);

  useEffect(() => {
    const row = listRef.current?.querySelector('[aria-selected="true"]');
    if (row && "scrollIntoView" in row) row.scrollIntoView({ block: "nearest" });
  }, [selected, rows]);

  const openFolder = (path: string) => { setFolder(path); setSelected(0); };
  const activate = (row: Row | undefined) => {
    if (!row) return;
    if (row.kind === "folder") openFolder(row.path);
    else onPick(row.file);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelected((i) => Math.min(i + 1, rows.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelected((i) => Math.max(i - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      activate(rows[selected]);
    }
  };

  const crumbs = folder === "" ? [] : folder.split("/");
  const message = state.status === "loading" ? "Loading…"
    : state.status === "error" ? state.message
    : rows.length === 0 ? (searching ? "No matches" : "No files")
    : null;

  return createPortal(
    <div
      className="local-picker-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Link a local file"
      onClick={(event) => {
        event.stopPropagation();
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="local-picker">
        <input
          ref={searchRef}
          className="input-control local-picker-search"
          type="text"
          role="combobox"
          aria-expanded={message === null}
          aria-controls="local-picker-list"
          aria-activedescendant={message === null ? `local-picker-row-${selected}` : undefined}
          aria-label="Search local files"
          placeholder="Search all files…"
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(event) => { setQuery(event.target.value); setSelected(0); }}
          onKeyDown={onKeyDown}
        />
        {!searching && state.status === "ok" && (
          <nav className="local-picker-crumbs" aria-label="Folder">
            <button type="button" onClick={() => openFolder("")}>pkm</button>
            {crumbs.map((segment, i) => (
              <Fragment key={i}>
                <span aria-hidden="true">›</span>
                <button type="button" onClick={() => openFolder(crumbs.slice(0, i + 1).join("/"))}>{segment}</button>
              </Fragment>
            ))}
          </nav>
        )}
        {message !== null ? (
          <p className="local-picker-note" role="status">{message}</p>
        ) : (
          <div className="local-picker-list" id="local-picker-list" role="listbox" aria-label="Files" ref={listRef}>
            {rows.map((row, i) => (
              <div
                key={row.key}
                id={`local-picker-row-${i}`}
                className={`local-picker-row${row.kind === "folder" ? " local-picker-folder" : ""}`}
                role="option"
                aria-selected={i === selected}
                onMouseMove={() => { if (i !== selected) setSelected(i); }}
                onClick={() => activate(row)}
              >
                {row.kind === "folder" ? row.name : (
                  <>
                    <span className="local-picker-name">
                      {highlighted(fileName(row.file.path), row.nameRanges)}
                    </span>
                    {searching && folderOf(row.file.path) !== "" && (
                      <span className="local-picker-folder-path">
                        {folderText(folderOf(row.file.path), row.folderRanges)}
                      </span>
                    )}
                  </>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
