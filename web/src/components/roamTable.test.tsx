import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { describe, expect, it, vi, type Mock } from "vitest";
import type { BlockUid, CanonicalTitle } from "../api/brands";
import type { BlockOp, CreateOp } from "../api/ops";
import type { BlockNode } from "../api/payloads";
import { BlockRefContext } from "../contexts";
import { roamTable } from "../outline/roamTableRows";
import type { OutlineHandlers } from "../outline/handlers";
import { block, canonicalTitleOf, orderIdxOf, uidOf } from "../test-helpers";
import { pagePath } from "../paths";
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

/** A ref a header can name: resolved, a BlockRef renders a link. */
const REFS = { abcDEF123: { text: "Referenced", page_title: PAGE } };

function mount(node: BlockNode, handlers: OutlineHandlers, editable = true) {
  const ui = (n: BlockNode) => {
    const tt = roamTable(n)!;
    return (
      <MemoryRouter>
        <BlockRefContext.Provider value={REFS}>
          <RoamTable node={n} rows={tt.rows} options={tt.options}
                     handlers={handlers} editable={editable} />
        </BlockRefContext.Provider>
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

  it("Save writes the view into the macro, planned against the live text", async () => {
    const node = table();
    const edits = planned(node);
    const { handlers } = spyHandlers({ onEditInBlock: edits.fn });
    const { rerenderNode } = mount(node, handlers);
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: "Cache hit" }));
    fireEvent.click(screen.getByRole("button", { name: "Save this view" }));
    expect(edits.ops).toEqual([[{ op: "update_text", uid: uidOf("tuid-table"),
                                  text: "{{table | sort: Cache hit asc}}" }]]);
    expect(screen.queryByRole("button", { name: "Save this view" })).toBeNull();
    rerenderNode(table("{{table | sort: Cache hit asc}}"));
    expect(screen.getByText("✓ saved view")).toBeInTheDocument();
    expect(bodyTexts()).toEqual(["nginx", "apache", "zeta"]);
  });

  it("a Save the outline refuses leaves the view unsaved", async () => {
    const node = table();
    const edits = planned(node);
    const refuse = vi.fn((uid: BlockUid,
                          plan: (n: BlockNode, t: CanonicalTitle) => BlockOp[]) => {
      edits.fn(uid, plan);
      return false;
    });
    const { handlers } = spyHandlers({ onEditInBlock: refuse });
    mount(node, handlers);
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: "Cache hit" }));
    fireEvent.click(screen.getByRole("button", { name: "Save this view" }));
    expect(refuse).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("✓ saved view")).toBeNull();
    expect(screen.getByRole("button", { name: "Save this view" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reset" })).toBeInTheDocument();
  });

  it("Save refuses when the block's live text is no longer a table macro", async () => {
    const edits = planned(table("{{table}} and more"));
    const { handlers } = spyHandlers({ onEditInBlock: edits.fn });
    mount(table(), handlers);
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: "Cache hit" }));
    fireEvent.click(screen.getByRole("button", { name: "Save this view" }));
    expect(edits.ops).toEqual([[]]);
    expect(screen.getByText(/no longer a table macro/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reset" })).toBeInTheDocument();
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

  it.each([
    ["[[Page X]]", "Page X"],
    ["#tagx", "#tagx"],
    ["((abcDEF123))", "((abcDEF123))"],
    ["https://e.com/a", "https://e.com/a"],
    ["[label](https://e.com/a)", "label"],
  ])("a header %s shows its text, carries no link, and sorts on click",
     async (headerText, shown) => {
    const { handlers } = spyHandlers();
    mount(table("{{table}}", [
      chain("tuid-h", ["Lab", headerText]),
      chain("tuid-a", ["apache", "b"]),
      chain("tuid-b", ["nginx", "a"]),
    ]), handlers);
    await loaded();
    const header = within(screen.getAllByRole("rowgroup")[0]!)
      .getAllByRole("columnheader")[1]!;
    expect(within(header).queryByRole("link")).toBeNull();
    expect(header.querySelector("a")).toBeNull();
    fireEvent.click(within(header).getByText(shown));
    expect(bodyTexts()).toEqual(["nginx", "apache"]);
  });

  it("a header keeps bold and code", async () => {
    const { handlers } = spyHandlers();
    mount(table("{{table}}", [
      chain("tuid-h", ["Lab", "**Hits** `n`"]),
      chain("tuid-a", ["apache", "1"]),
    ]), handlers);
    await loaded();
    const header = within(screen.getAllByRole("rowgroup")[0]!)
      .getAllByRole("columnheader")[1]!;
    expect(header.querySelector("strong")?.textContent).toBe("Hits");
    expect(header.querySelector("code")?.textContent).toBe("n");
  });

  it("Save refuses a sort on a header that is a block ref", async () => {
    const { handlers, called } = spyHandlers();
    mount(table("{{table}}", [
      chain("tuid-h", ["Lab", "((abcDEF123))"]),
      chain("tuid-a", ["apache", "40"]),
    ]), handlers);
    await loaded();
    const header = within(screen.getAllByRole("rowgroup")[0]!)
      .getAllByRole("columnheader")[1]!;
    fireEvent.click(within(header).getAllByRole("button")[0]!);
    expect(screen.queryByRole("button", { name: "Save this view" })).toBeNull();
    expect(screen.getByText(/cannot contain '\(\('/)).toBeInTheDocument();
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

const IMG = `![Bed](/assets/${"ab".repeat(32)}/bed.png)`;
const MERMAID = "```mermaid\ngraph TD; A-->B\n```";
const POST = "https://bsky.app/profile/alice.bsky.social/post/3k2abc123xy";

/** A table whose body rows hold, in their second cells, an image
 * (tuid-ax), a mermaid block (tuid-bx) and a Bluesky post (tuid-cx). */
const mediaTable = () => table("{{table}}", [
  chain("tuid-h", ["Lab", "Media"]),
  chain("tuid-a", ["apache", IMG]),
  chain("tuid-b", ["nginx", MERMAID]),
  chain("tuid-c", ["bsky", POST]),
]);

function LocProbe() {
  const loc = useLocation();
  return <p data-testid="loc">{loc.pathname + loc.hash}</p>;
}

function mountMedia() {
  const { handlers } = spyHandlers();
  const ui = (n: BlockNode) => {
    const tt = roamTable(n)!;
    return (
      <MemoryRouter initialEntries={[pagePath(PAGE)]}>
        <RoamTable node={n} rows={tt.rows} options={tt.options}
                   handlers={handlers} editable />
        <LocProbe />
      </MemoryRouter>
    );
  };
  const utils = render(ui(mediaTable()));
  return { ...utils, rerenderNode: (n: BlockNode) => utils.rerender(ui(n)) };
}

const imageLabel = () =>
  screen.getByRole("button", { name: "Open image full screen: Bed" });
const tableEditor = () =>
  screen.getByRole("table").querySelector("textarea");

describe("RoamTable media cells", () => {
  it("label_click_does_not_open_the_cell", async () => {
    mountMedia();
    await loaded();
    fireEvent.click(imageLabel());
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(tableEditor()).toBeNull();
  });

  it("escape_in_the_viewer_closes_it_not_the_cell", async () => {
    mountMedia();
    await loaded();
    const label = imageLabel();
    label.focus();
    fireEvent.click(label);
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(tableEditor()).toBeNull();
    expect(label).toHaveFocus();
  });

  it("enter_in_the_viewer_does_not_open_the_cell", async () => {
    mountMedia();
    await loaded();
    fireEvent.click(imageLabel());
    const dialog = screen.getByRole("dialog");
    const close = within(dialog).getByRole("button", { name: "Close" });
    expect(close).toHaveFocus();
    fireEvent.keyDown(close, { key: "Enter" });
    fireEvent.click(dialog);
    expect(tableEditor()).toBeNull();
  });

  it("click_beside_the_label_still_opens_the_cell", async () => {
    mountMedia();
    await loaded();
    fireEvent.click(imageLabel().closest("td")!);
    expect(tableEditor()).not.toBeNull();
  });

  it("a_rerender_keeps_the_viewer_open", async () => {
    const { rerenderNode } = mountMedia();
    await loaded();
    fireEvent.click(imageLabel());
    rerenderNode(mediaTable());
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("td_carries_the_cell_uid", async () => {
    mountMedia();
    await loaded();
    expect(imageLabel().closest("td"))
      .toHaveAttribute("data-cell-uid", "tuid-ax");
    expect(imageLabel().closest("td")).not.toHaveAttribute("data-uid");
  });

  it("a mermaid cell shows its source as code, with no label", async () => {
    mountMedia();
    await loaded();
    expect(screen.queryByRole("button", { name: /Mermaid/ })).toBeNull();
    const pre = screen.getByText("graph TD; A-->B").closest("pre.code-block");
    expect(pre).not.toBeNull();
    expect(pre!.closest("td")).toHaveAttribute("data-cell-uid", "tuid-bx");
  });

  it("a click on a code cell opens the cell editor", async () => {
    mountMedia();
    await loaded();
    fireEvent.click(screen.getByText("graph TD; A-->B"));
    expect(tableEditor()).not.toBeNull();
  });

  it("a Bluesky cell is a link whose click opens no editor", async () => {
    mountMedia();
    await loaded();
    const link = screen.getByRole("link", { name: POST });
    expect(link).toHaveAttribute("href", POST);
    fireEvent.click(link);
    expect(tableEditor()).toBeNull();
    expect(screen.getByTestId("loc")).toHaveTextContent(pagePath(PAGE));
  });
});

describe("RoamTable media cells before the tables chunk loads", () => {
  it("shows labels, fetches nothing and anchors the cell", async () => {
    vi.resetModules();
    const fresh = await import("./roamTable");
    const t = roamTable(mediaTable())!;
    const { handlers } = spyHandlers();
    const { container } = render(
      <MemoryRouter>
        <fresh.RoamTable node={mediaTable()} rows={t.rows}
                         options={t.options} handlers={handlers} editable />
      </MemoryRouter>);
    expect(screen.getByRole("table")).toHaveClass("roam-table");
    expect(container.querySelector("img")).toBeNull();
    expect(imageLabel().closest("td"))
      .toHaveAttribute("data-cell-uid", "tuid-ax");
    expect(screen.getByText("graph TD; A-->B").closest("pre.code-block"))
      .not.toBeNull();
    expect(screen.queryByRole("button", { name: /Mermaid/ })).toBeNull();
    await loaded();
    vi.resetModules();
  });
});
