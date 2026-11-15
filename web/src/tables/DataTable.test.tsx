import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stubFetch } from "../test-helpers";
import { DataTable, type Column, type DataTableProps } from "./DataTable";

interface Row { id: string; name: string; status: string; year: string }

const COLUMNS: Column[] = [
  { key: "name", label: "Name", editable: false },
  { key: "status", label: "Status", editable: true },
  { key: "year", label: "Year", editable: true, numeric: true },
];

const ROWS: Row[] = [
  { id: "a", name: "Alpha", status: "Read", year: "2017" },
  { id: "b", name: "Beta", status: "", year: "2020" },
];

function mount(over: Partial<DataTableProps<Row>> = {}) {
  const onWrite = vi.fn();
  const onSortClick = vi.fn();
  const props: DataTableProps<Row> = {
    columns: COLUMNS, rows: ROWS, rowId: (r) => r.id,
    renderCell: (r, c) => c.key === "name"
      ? <a href={`#${r.name}`}>{r.name}</a>
      : r[c.key as keyof Row],
    rawValue: (r, c) => r[c.key as keyof Row],
    sort: null, onSortClick, canEdit: true, onWrite, ...over,
  };
  const utils = render(<DataTable {...props} />);
  return { ...utils, onWrite, onSortClick };
}

function cell(row: number, col: string): HTMLElement {
  const tr = screen.getAllByRole("row")[row + 1]!;
  const at = COLUMNS.findIndex((c) => c.key === col);
  return within(tr).getAllByRole("cell")[at]!;
}

function editor(): HTMLTextAreaElement {
  return document.querySelector("textarea.cell-editor") as HTMLTextAreaElement;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("DataTable editing", () => {
  it("clicking an editable cell opens a textarea holding the raw value", () => {
    mount();
    fireEvent.click(cell(0, "status"));
    expect(editor().tagName).toBe("TEXTAREA");
    expect(editor().value).toBe("Read");
    expect(document.activeElement).toBe(editor());
  });

  it("Enter writes the trimmed draft and closes the editor", () => {
    const { onWrite } = mount();
    fireEvent.click(cell(0, "status"));
    fireEvent.change(editor(), { target: { value: "  Unread " } });
    fireEvent.keyDown(editor(), { key: "Enter" });
    expect(onWrite).toHaveBeenCalledWith(ROWS[0], COLUMNS[1], "Unread");
    expect(editor()).toBeNull();
  });

  it("Shift-Enter is not intercepted, so it can insert a newline", () => {
    const { onWrite } = mount();
    fireEvent.click(cell(0, "status"));
    const ta = editor();
    const notPrevented = fireEvent.keyDown(ta, { key: "Enter", shiftKey: true });
    expect(notPrevented).toBe(true);
    fireEvent.change(ta, { target: { value: "Read\nagain" } });
    expect(onWrite).not.toHaveBeenCalled();
    expect(editor().value).toBe("Read\nagain");
  });

  it("Esc closes without writing", () => {
    const { onWrite } = mount();
    fireEvent.click(cell(0, "status"));
    fireEvent.change(editor(), { target: { value: "Unread" } });
    fireEvent.keyDown(editor(), { key: "Escape" });
    expect(onWrite).not.toHaveBeenCalled();
    expect(editor()).toBeNull();
  });

  it("Tab writes and moves along the row, wrapping, and Shift-Tab goes back", () => {
    const { onWrite } = mount();
    fireEvent.click(cell(0, "status"));
    fireEvent.change(editor(), { target: { value: "Unread" } });
    const tab = fireEvent.keyDown(editor(), { key: "Tab" });
    expect(tab).toBe(false);
    expect(onWrite).toHaveBeenCalledWith(ROWS[0], COLUMNS[1], "Unread");
    expect(editor().value).toBe("2017");
    expect(cell(0, "year")).toContainElement(editor());
    expect(document.activeElement).toBe(editor());

    fireEvent.keyDown(editor(), { key: "Tab" });
    expect(cell(1, "status")).toContainElement(editor());

    fireEvent.keyDown(editor(), { key: "Tab", shiftKey: true });
    expect(cell(0, "year")).toContainElement(editor());
    expect(onWrite).toHaveBeenCalledTimes(1);
  });

  it("Tab past the last editable cell closes the editor", () => {
    mount();
    fireEvent.click(cell(1, "year"));
    fireEvent.keyDown(editor(), { key: "Tab" });
    expect(editor()).toBeNull();
  });

  it("a mousedown outside the editor commits", () => {
    const { onWrite } = mount();
    fireEvent.click(cell(0, "status"));
    fireEvent.change(editor(), { target: { value: "Unread" } });
    fireEvent.mouseDown(editor());
    expect(onWrite).not.toHaveBeenCalled();
    fireEvent.mouseDown(document.body);
    expect(onWrite).toHaveBeenCalledWith(ROWS[0], COLUMNS[1], "Unread");
    expect(editor()).toBeNull();
  });

  it("a mousedown that stops propagating still commits", () => {
    const onWrite = vi.fn();
    render(<>
      <button type="button" onMouseDown={(e) => e.stopPropagation()}>other</button>
      <DataTable columns={COLUMNS} rows={ROWS} rowId={(r) => r.id}
                 renderCell={(r, c) => r[c.key as keyof Row]}
                 rawValue={(r, c) => r[c.key as keyof Row]}
                 sort={null} onSortClick={vi.fn()} canEdit onWrite={onWrite} />
    </>);
    fireEvent.click(cell(0, "status"));
    fireEvent.change(editor(), { target: { value: "Unread" } });
    fireEvent.mouseDown(screen.getByRole("button", { name: "other" }));
    expect(onWrite).toHaveBeenCalledWith(ROWS[0], COLUMNS[1], "Unread");
  });

  it("losing canEdit keeps an open cell and its draft, and it still commits", () => {
    const { onWrite, rerender } = mount();
    fireEvent.click(cell(0, "status"));
    fireEvent.change(editor(), { target: { value: "Unr" } });
    const props = {
      columns: COLUMNS, rows: ROWS, rowId: (r: Row) => r.id,
      renderCell: (r: Row, c: Column) => r[c.key as keyof Row],
      rawValue: (r: Row, c: Column) => r[c.key as keyof Row],
      sort: null, onSortClick: vi.fn(), onWrite,
    };
    rerender(<DataTable {...props} canEdit={false} />);
    expect(editor().value).toBe("Unr");
    expect(onWrite).not.toHaveBeenCalled();
    fireEvent.click(cell(1, "status"));
    expect(editor().value).toBe("Unr");
    fireEvent.change(editor(), { target: { value: "Unread" } });
    fireEvent.keyDown(editor(), { key: "Enter" });
    expect(onWrite).toHaveBeenCalledTimes(1);
    expect(onWrite).toHaveBeenCalledWith(ROWS[0], COLUMNS[1], "Unread");
    fireEvent.click(cell(0, "status"));
    expect(editor()).toBeNull();
  });

  it("a mousedown in the open cell's own padding keeps it open", () => {
    const { onWrite } = mount();
    fireEvent.click(cell(0, "status"));
    fireEvent.change(editor(), { target: { value: "Unread" } });
    expect(fireEvent.mouseDown(cell(0, "status"))).toBe(false);
    fireEvent.click(cell(0, "status"));
    expect(onWrite).not.toHaveBeenCalled();
    expect(editor().value).toBe("Unread");
    fireEvent.keyDown(editor(), { key: "Enter" });
    expect(onWrite).toHaveBeenCalledTimes(1);
  });

  it("focus moving elsewhere by keyboard commits", () => {
    const onWrite = vi.fn();
    render(<>
      <input aria-label="search" />
      <DataTable columns={COLUMNS} rows={ROWS} rowId={(r) => r.id}
                 renderCell={(r, c) => r[c.key as keyof Row]}
                 rawValue={(r, c) => r[c.key as keyof Row]}
                 sort={null} onSortClick={vi.fn()} canEdit onWrite={onWrite} />
    </>);
    fireEvent.click(cell(0, "status"));
    fireEvent.change(editor(), { target: { value: "Unread" } });
    act(() => { screen.getByRole("textbox", { name: "search" }).focus(); });
    expect(onWrite).toHaveBeenCalledWith(ROWS[0], COLUMNS[1], "Unread");
    expect(onWrite).toHaveBeenCalledTimes(1);
    expect(editor()).toBeNull();
  });

  it("the window losing focus leaves the cell open", () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    const { onWrite } = mount();
    fireEvent.click(cell(0, "status"));
    fireEvent.change(editor(), { target: { value: "Unread" } });
    fireEvent.blur(editor(), { relatedTarget: null });
    expect(onWrite).not.toHaveBeenCalled();
    expect(editor().value).toBe("Unread");
  });

  it("a table unmounted with a changed cell open commits it", () => {
    const { onWrite, unmount } = mount();
    fireEvent.click(cell(0, "status"));
    fireEvent.change(editor(), { target: { value: "Unread" } });
    unmount();
    expect(onWrite).toHaveBeenCalledWith(ROWS[0], COLUMNS[1], "Unread");
    expect(onWrite).toHaveBeenCalledTimes(1);
  });

  it("a table unmounted with an unchanged cell open writes nothing", () => {
    const { onWrite, unmount } = mount();
    fireEvent.click(cell(0, "status"));
    unmount();
    expect(onWrite).not.toHaveBeenCalled();
  });

  it("clicking another cell commits the open one and opens that one", () => {
    const { onWrite } = mount();
    fireEvent.click(cell(0, "status"));
    fireEvent.change(editor(), { target: { value: "Unread" } });
    fireEvent.click(cell(1, "year"));
    expect(onWrite).toHaveBeenCalledWith(ROWS[0], COLUMNS[1], "Unread");
    expect(cell(1, "year")).toContainElement(editor());
  });

  it("an open cell whose row goes away commits to that row", () => {
    const { onWrite, rerender } = mount();
    fireEvent.click(cell(0, "status"));
    fireEvent.change(editor(), { target: { value: "Unread" } });
    const props = {
      columns: COLUMNS, rows: [ROWS[1]!], rowId: (r: Row) => r.id,
      renderCell: (r: Row, c: Column) => r[c.key as keyof Row],
      rawValue: (r: Row, c: Column) => r[c.key as keyof Row],
      sort: null, onSortClick: vi.fn(), canEdit: true, onWrite,
    };
    rerender(<DataTable {...props} />);
    expect(onWrite).toHaveBeenCalledWith(ROWS[0], COLUMNS[1], "Unread");
    expect(editor()).toBeNull();
  });

  it("clicking a link inside a cell does not open the editor", () => {
    mount({ columns: COLUMNS.map((c) => ({ ...c, editable: true })) });
    fireEvent.click(screen.getByRole("link", { name: "Alpha" }));
    expect(editor()).toBeNull();
  });

  it("opens no editor without canEdit, and none on a read-only column", () => {
    mount({ canEdit: false });
    fireEvent.click(cell(0, "status"));
    expect(editor()).toBeNull();
    fireEvent.click(cell(0, "name"));
    expect(editor()).toBeNull();
  });

  it("clicks and keys inside the table do not reach the host block", () => {
    const hostClick = vi.fn();
    const hostKey = vi.fn();
    render(
      <div onClick={hostClick} onKeyDown={hostKey}>
        <DataTable columns={COLUMNS} rows={ROWS} rowId={(r) => r.id}
                   renderCell={(r, c) => r[c.key as keyof Row]}
                   rawValue={(r, c) => r[c.key as keyof Row]}
                   sort={null} onSortClick={vi.fn()} canEdit onWrite={vi.fn()} />
      </div>);
    fireEvent.click(cell(0, "status"));
    fireEvent.keyDown(editor(), { key: "a" });
    fireEvent.keyDown(editor(), { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: /Year/ }));
    expect(hostClick).not.toHaveBeenCalled();
    expect(hostKey).not.toHaveBeenCalled();
  });

  it("a Cmd chord still reaches the app's global shortcuts", () => {
    const hostKey = vi.fn();
    render(
      <div onKeyDown={hostKey}>
        <DataTable columns={COLUMNS} rows={ROWS} rowId={(r) => r.id}
                   renderCell={(r, c) => r[c.key as keyof Row]}
                   rawValue={(r, c) => r[c.key as keyof Row]}
                   sort={null} onSortClick={vi.fn()} canEdit onWrite={vi.fn()} />
      </div>);
    fireEvent.click(cell(0, "status"));
    fireEvent.keyDown(editor(), { key: "u", metaKey: true });
    expect(hostKey).toHaveBeenCalledTimes(1);
  });
});

describe("DataTable headers and rows", () => {
  it("a header click asks for that column's sort", () => {
    const { onSortClick } = mount();
    fireEvent.click(screen.getByRole("button", { name: /Status/ }));
    expect(onSortClick).toHaveBeenCalledWith("status");
  });

  it("only the sorted column shows its direction", () => {
    const { rerender } = mount({ sort: { col: "year", dir: "asc" } });
    const year = screen.getByRole("columnheader", { name: /Year/ });
    expect(year).toHaveAttribute("aria-sort", "ascending");
    expect(year).toHaveTextContent("▲");
    expect(screen.getByRole("columnheader", { name: /Status/ }))
      .not.toHaveAttribute("aria-sort");
    expect(screen.getByRole("columnheader", { name: /Status/ }))
      .not.toHaveTextContent(/[▲▼]/);

    rerender(<DataTable columns={COLUMNS} rows={ROWS} rowId={(r) => r.id}
                        renderCell={(r, c) => r[c.key as keyof Row]}
                        rawValue={(r, c) => r[c.key as keyof Row]}
                        sort={{ col: "year", dir: "desc" }} onSortClick={vi.fn()}
                        canEdit onWrite={vi.fn()} />);
    expect(screen.getByRole("columnheader", { name: /Year/ }))
      .toHaveAttribute("aria-sort", "descending");
    expect(screen.getByRole("columnheader", { name: /Year/ }))
      .toHaveTextContent("▼");
  });

  it("a stale row is dimmed and says it no longer matches", () => {
    mount({ staleIds: new Set(["b"]) });
    const rows = screen.getAllByRole("row");
    expect(rows[2]).toHaveClass("stale");
    expect(rows[2]).toHaveTextContent("no longer matches");
    expect(rows[1]).not.toHaveClass("stale");
  });

  it("a numeric column's cells are marked numeric", () => {
    mount();
    expect(cell(0, "year")).toHaveClass("numeric");
    expect(cell(0, "status")).not.toHaveClass("numeric");
  });
});

describe("DataTable suggestions and hints", () => {
  const suggest = (_r: Row, _c: Column, typed: string) =>
    [{ value: "Read", count: 3 }, { value: "Reading", count: 2 }]
      .filter((s) => s.value.toLowerCase().startsWith(typed.toLowerCase()));

  it("shows suggestions with their counts, none highlighted", () => {
    mount({ suggest });
    fireEvent.click(cell(1, "status"));
    const options = screen.getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["Read3", "Reading2"]);
    expect(options.every((o) => o.getAttribute("aria-selected") === "false"))
      .toBe(true);
  });

  it("arrow keys and Enter pick a suggestion into the draft, then Enter commits", () => {
    const { onWrite } = mount({ suggest });
    fireEvent.click(cell(1, "status"));
    fireEvent.keyDown(editor(), { key: "ArrowDown" });
    fireEvent.keyDown(editor(), { key: "ArrowDown" });
    fireEvent.keyDown(editor(), { key: "ArrowUp" });
    expect(screen.getAllByRole("option")[0])
      .toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(editor(), { key: "Enter" });
    expect(onWrite).not.toHaveBeenCalled();
    expect(editor().value).toBe("Read");
    fireEvent.keyDown(editor(), { key: "Enter" });
    expect(onWrite).toHaveBeenCalledWith(ROWS[1], COLUMNS[1], "Read");
  });

  it("typing narrows the suggestions and clears the highlight", () => {
    mount({ suggest });
    fireEvent.click(cell(1, "status"));
    fireEvent.keyDown(editor(), { key: "ArrowDown" });
    fireEvent.change(editor(), { target: { value: "Readi" } });
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveAttribute("aria-selected", "false");
  });

  it("a mousedown on a suggestion picks it and keeps the editor open", () => {
    const { onWrite } = mount({ suggest });
    fireEvent.click(cell(1, "status"));
    fireEvent.mouseDown(screen.getByRole("option", { name: /Reading/ }));
    expect(onWrite).not.toHaveBeenCalled();
    expect(editor().value).toBe("Reading");
  });

  it("shows the cell's hint beside the editor", () => {
    mount({ cellHint: (r) => r.id === "b" ? "No Status:: here" : null });
    fireEvent.click(cell(1, "status"));
    expect(screen.getByText("No Status:: here")).toBeInTheDocument();
  });

  it("listens for scrolls only while the popup shows", () => {
    const listen = vi.spyOn(window, "addEventListener");
    const scrollListeners = () =>
      listen.mock.calls.filter((call) => String(call[0]) === "scroll").length;
    mount({ suggest });
    fireEvent.click(cell(0, "year"));
    fireEvent.change(editor(), { target: { value: "zzz" } });
    expect(scrollListeners()).toBe(0);
    fireEvent.change(editor(), { target: { value: "R" } });
    expect(scrollListeners()).toBe(1);
  });

  it("shows no popup when there is nothing to suggest or say", () => {
    mount({ suggest: () => [], cellHint: () => null });
    fireEvent.click(cell(1, "status"));
    expect(document.querySelector(".cell-editor-popup")).toBeNull();
  });

  it("[[ offers page titles, and Enter completes the ref without closing", async () => {
    vi.useFakeTimers();
    stubFetch([["/api/titles", { titles: ["Gregor Hohpe", "Gregory"] }]]);
    const { onWrite } = mount();
    fireEvent.click(cell(1, "status"));
    const ta = editor();
    fireEvent.change(ta, { target: { value: "[[Greg" } });
    ta.setSelectionRange(6, 6);
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    expect(screen.getByRole("option", { name: "Gregor Hohpe" }))
      .toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(ta, { key: "ArrowDown" });
    fireEvent.keyDown(ta, { key: "Enter" });
    expect(onWrite).not.toHaveBeenCalled();
    expect(editor().value).toBe("[[Gregory]]");
    expect(editor().selectionStart).toBe(11);
    expect(screen.queryByRole("option")).toBeNull();
  });

  it("Esc closes the title list before it cancels the edit", async () => {
    vi.useFakeTimers();
    stubFetch([["/api/titles", { titles: ["Gregor Hohpe"] }]]);
    const { onWrite } = mount();
    fireEvent.click(cell(1, "status"));
    const ta = editor();
    fireEvent.change(ta, { target: { value: "[[Greg" } });
    ta.setSelectionRange(6, 6);
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    fireEvent.keyDown(ta, { key: "Escape" });
    expect(screen.queryByRole("option")).toBeNull();
    expect(editor()).not.toBeNull();
    fireEvent.keyDown(ta, { key: "Escape" });
    expect(editor()).toBeNull();
    expect(onWrite).not.toHaveBeenCalled();
  });

  it("a mousedown on a title row completes it", async () => {
    vi.useFakeTimers();
    stubFetch([["/api/titles", { titles: ["Gregor Hohpe"] }]]);
    mount();
    fireEvent.click(cell(1, "status"));
    const ta = editor();
    fireEvent.change(ta, { target: { value: "by #Gre" } });
    ta.setSelectionRange(7, 7);
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    fireEvent.mouseDown(screen.getByRole("option", { name: "Gregor Hohpe" }));
    expect(editor().value).toBe("by #[[Gregor Hohpe]]");
  });

  it("a slash in a cell opens no command menu", () => {
    mount();
    fireEvent.click(cell(1, "status"));
    fireEvent.change(editor(), { target: { value: "a /da" } });
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});
