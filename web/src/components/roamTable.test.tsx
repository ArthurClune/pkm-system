import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi, type Mock } from "vitest";
import type { BlockUid, CanonicalTitle } from "../api/brands";
import type { BlockOp, CreateOp } from "../api/ops";
import type { BlockNode } from "../api/payloads";
import { roamTable } from "../outline/roamTableRows";
import type { OutlineHandlers } from "../outline/handlers";
import { block, canonicalTitleOf, orderIdxOf, uidOf } from "../test-helpers";
import { RoamTable } from "./roamTable";

const PAGE = canonicalTitleOf("Lab notes");

/** Every handler a spy, made on first use, so a test can say none ran. */
function spyHandlers(over: Partial<Record<keyof OutlineHandlers, Mock>> = {}) {
  const fns = new Map<string, Mock>(Object.entries(over));
  const handlers = new Proxy({} as OutlineHandlers, {
    get: (_, key: string) => {
      if (!fns.has(key)) fns.set(key, vi.fn(() => (key === "onEditInBlock" ? false : undefined)));
      return fns.get(key);
    },
  });
  const called = () => [...fns].filter(([, f]) => f.mock.calls.length > 0)
    .map(([k]) => k);
  return { handlers, fns, called };
}

/** An onEditInBlock that runs each plan against `node` and keeps its ops. */
function planned(node: BlockNode) {
  const ops: BlockOp[][] = [];
  const fn = vi.fn((_uid: BlockUid,
                    plan: (n: BlockNode, t: CanonicalTitle) => BlockOp[]) => {
    const out = plan(node, PAGE);
    ops.push(out);
    return out.length > 0;
  });
  return { fn, ops };
}

const creates = (ops: BlockOp[]): CreateOp[] =>
  ops.flatMap((op) => (op.op === "create" ? [op] : []));

/** The row a new-row batch makes, as the tree would hold it. */
function newRow(ops: BlockOp[]): BlockNode {
  const [first, second] = creates(ops);
  return block(first!.uid, "", { order_idx: orderIdxOf(4), children: [
    block(second!.uid, "")] });
}

function chain(id: string, texts: string[]): BlockNode {
  const [first, ...rest] = texts;
  return block(id, first!, {
    children: rest.length > 0 ? [chain(`${id}x`, rest)] : [] });
}

function table(text = "{{table}}", rows: BlockNode[] = [
  chain("tuid-h", ["Lab", "Cache hit"]),
  chain("tuid-a", ["apache", "40"]),
  chain("tuid-b", ["nginx", "7"]),
  block("tuid-c", "zeta", { order_idx: orderIdxOf(3) }),
]): BlockNode {
  return block("tuid-table", text, { children: rows });
}

function mount(node: BlockNode, handlers: OutlineHandlers, editable = true) {
  const ui = (n: BlockNode) => {
    const tt = roamTable(n)!;
    return (
      <MemoryRouter>
        <RoamTable node={n} rows={tt.rows} options={tt.options}
                   handlers={handlers} editable={editable} />
      </MemoryRouter>
    );
  };
  const utils = render(ui(node));
  return { ...utils, rerenderNode: (n: BlockNode) => utils.rerender(ui(n)) };
}

const bodyTexts = () => within(screen.getAllByRole("rowgroup")[1]!)
  .getAllByRole("row").map((r) => within(r).getAllByRole("cell")[0]!.textContent);

const editor = () => document.querySelector("textarea.cell-editor") as HTMLTextAreaElement;

async function loaded() {
  await screen.findByText(/of \d+ rows/);
}

describe("RoamTable", () => {
  it("shows the plain table while its editor loads, then the editor", async () => {
    const { handlers } = spyHandlers();
    mount(table(), handlers);
    expect(screen.getByRole("table")).toHaveClass("roam-table");
    await loaded();
    expect(screen.getByRole("table")).toHaveClass("data-table");
    expect(screen.getByText("3 of 3 rows")).toBeInTheDocument();
  });

  it("sorts body rows with the header first, and sorting calls no handler", async () => {
    const { handlers, called } = spyHandlers();
    mount(table(), handlers);
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: "Cache hit" }));
    expect(bodyTexts()).toEqual(["nginx", "apache", "zeta"]);
    fireEvent.click(screen.getByRole("button", { name: "Lab" }));
    fireEvent.click(screen.getByRole("button", { name: "Lab" }));
    expect(bodyTexts()).toEqual(["zeta", "nginx", "apache"]);
    expect(within(screen.getAllByRole("rowgroup")[0]!).getAllByRole("columnheader")
      .map((h) => h.textContent)).toEqual(["Lab▼", "Cache hit"]);
    expect(called()).toEqual([]);
  });

  it("filters body rows and counts them", async () => {
    const { handlers, called } = spyHandlers();
    mount(table(), handlers);
    await loaded();
    fireEvent.change(screen.getByRole("searchbox", { name: "Filter" }),
                     { target: { value: "ng" } });
    expect(bodyTexts()).toEqual(["nginx"]);
    expect(screen.getByText("1 of 3 rows")).toBeInTheDocument();
    expect(called()).toEqual([]);
  });

  it("a cell commit writes the cell's block through onEditInBlock", async () => {
    const node = table();
    const edits = planned(node);
    const { handlers } = spyHandlers({ onEditInBlock: edits.fn });
    mount(node, handlers);
    await loaded();
    fireEvent.click(screen.getByText("40"));
    fireEvent.change(editor(), { target: { value: "41" } });
    fireEvent.keyDown(editor(), { key: "Enter" });
    expect(edits.fn).toHaveBeenCalledTimes(1);
    expect(edits.fn.mock.calls[0]![0]).toBe("tuid-table");
    expect(edits.ops).toEqual([[
      { op: "update_text", uid: uidOf("tuid-ax"), text: "41" }]]);
  });

  it("an edited row keeps its place until the view changes", async () => {
    const node = table();
    const edits = planned(node);
    const { handlers } = spyHandlers({ onEditInBlock: edits.fn });
    const { rerenderNode } = mount(node, handlers);
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: "Cache hit" }));
    expect(bodyTexts()).toEqual(["nginx", "apache", "zeta"]);
    fireEvent.click(screen.getByText("7"));
    fireEvent.change(editor(), { target: { value: "99" } });
    fireEvent.keyDown(editor(), { key: "Enter" });
    rerenderNode(table("{{table}}", [
      node.children[0]!, node.children[1]!, chain("tuid-b", ["nginx", "99"]),
      node.children[3]!]));
    expect(bodyTexts()).toEqual(["nginx", "apache", "zeta"]);
    fireEvent.click(screen.getByRole("button", { name: "Lab" }));
    fireEvent.click(screen.getByRole("button", { name: "Cache hit" }));
    expect(bodyTexts()).toEqual(["apache", "nginx", "zeta"]);
  });

  it("a padding cell's commit creates its block", async () => {
    const node = table();
    const edits = planned(node);
    const { handlers } = spyHandlers({ onEditInBlock: edits.fn });
    mount(node, handlers);
    await loaded();
    const zeta = screen.getByText("zeta").closest("tr")!;
    fireEvent.click(within(zeta).getAllByRole("cell")[1]!);
    fireEvent.change(editor(), { target: { value: "3" } });
    fireEvent.keyDown(editor(), { key: "Enter" });
    expect(edits.ops).toHaveLength(1);
    expect(edits.ops[0]).toEqual([expect.objectContaining(
      { op: "create", parent_uid: "tuid-c", text: "3", page_title: PAGE })]);
  });

  it("+ New row adds a row through onEditInBlock and opens its first cell", async () => {
    const node = table();
    const edits = planned(node);
    const { handlers } = spyHandlers({ onEditInBlock: edits.fn });
    const { rerenderNode } = mount(node, handlers);
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: "+ New row" }));
    expect(edits.fn).toHaveBeenCalledTimes(1);
    const [first, second] = creates(edits.ops[0]!);
    expect(edits.ops[0]).toHaveLength(2);
    expect(first).toMatchObject({ parent_uid: "tuid-table", order_idx: 4, text: "" });
    expect(second).toMatchObject({ parent_uid: first!.uid, text: "" });

    rerenderNode(table("{{table}}", [...node.children, newRow(edits.ops[0]!)]));
    expect(editor()).not.toBeNull();
    expect(document.activeElement).toBe(editor());
    expect(editor().closest("tr")!.rowIndex).toBe(4);
  });

  it("a new row shows under a filter it does not match, until the view changes", async () => {
    const node = table();
    const edits = planned(node);
    const { handlers } = spyHandlers({ onEditInBlock: edits.fn });
    const { rerenderNode } = mount(node, handlers);
    await loaded();
    const filter = screen.getByRole("searchbox", { name: "Filter" });
    fireEvent.change(filter, { target: { value: "ng" } });
    fireEvent.click(screen.getByRole("button", { name: "+ New row" }));
    rerenderNode(table("{{table}}", [...node.children, newRow(edits.ops[0]!)]));
    expect(bodyTexts()).toHaveLength(2);
    expect(screen.getByText("1 of 4 rows")).toBeInTheDocument();
    fireEvent.keyDown(editor(), { key: "Escape" });
    fireEvent.change(filter, { target: { value: "ngi" } });
    expect(bodyTexts()).toEqual(["nginx"]);
  });

  it("Edit as text focuses the table block", async () => {
    const { handlers, fns } = spyHandlers();
    mount(table(), handlers);
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: "Edit as text" }));
    expect(fns.get("onFocusBlock")).toHaveBeenCalledWith("tuid-table", "{{table}}".length);
  });

  it("Save writes the view into the macro through onSetText", async () => {
    const { handlers, fns } = spyHandlers();
    const { rerenderNode } = mount(table(), handlers);
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: "Cache hit" }));
    fireEvent.click(screen.getByRole("button", { name: "Save this view" }));
    expect(fns.get("onSetText"))
      .toHaveBeenCalledWith("tuid-table", "{{table | sort: Cache hit asc}}");
    rerenderNode(table("{{table | sort: Cache hit asc}}"));
    expect(screen.getByText("✓ saved view")).toBeInTheDocument();
    expect(bodyTexts()).toEqual(["nginx", "apache", "zeta"]);
  });

  it("a saved view starts sorted and filtered", async () => {
    const { handlers } = spyHandlers();
    mount(table("  {{table | filter: a | sort: Lab desc}}"), handlers);
    await loaded();
    expect(bodyTexts()).toEqual(["apache"]);
    expect(screen.getByText("1 of 3 rows")).toBeInTheDocument();
  });

  it("Save refuses a filter the macro cannot hold", async () => {
    const { handlers, called } = spyHandlers();
    mount(table(), handlers);
    await loaded();
    fireEvent.change(screen.getByRole("searchbox", { name: "Filter" }),
                     { target: { value: "a | b" } });
    expect(screen.queryByRole("button", { name: "Save this view" })).toBeNull();
    expect(screen.getByText(/cannot contain '\|'/)).toBeInTheDocument();
    expect(called()).toEqual([]);
  });

  it("a read-only table sorts and filters but opens no cell and offers no writes", async () => {
    const { handlers, called } = spyHandlers();
    mount(table(), handlers, false);
    await loaded();
    fireEvent.click(screen.getByText("40"));
    expect(editor()).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cache hit" }));
    expect(screen.queryByRole("button", { name: "Save this view" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit as text" })).toBeNull();
    expect(screen.queryByRole("button", { name: "+ New row" })).toBeNull();
    expect(called()).toEqual([]);
  });

  it("clicks inside the editable table do not reach the block row", async () => {
    const { handlers } = spyHandlers();
    const hostClick = vi.fn();
    const t = roamTable(table())!;
    render(
      <MemoryRouter>
        <div onClick={hostClick}>
          <RoamTable node={table()} rows={t.rows} options={t.options}
                     handlers={handlers} editable />
        </div>
      </MemoryRouter>);
    await loaded();
    fireEvent.click(screen.getByText("40"));
    fireEvent.click(screen.getByRole("button", { name: "Lab" }));
    fireEvent.click(screen.getByText("3 of 3 rows"));
    fireEvent.click(screen.getByRole("button", { name: "+ New row" }));
    expect(hostClick).not.toHaveBeenCalled();
  });
});
