import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  KeyStat, QueryGroup, QueryRecordModel, QueryRecordsPayload, RecordCell,
} from "../api/payloads";
import {
  READ_INIT, block, canonicalTitleOf, defer, jsonResponse, makeSync,
  orderIdxOf, pageIdOf, rawTitleOf, stubFetch, uidOf, type SyncFake,
} from "../test-helpers";
import { BlockEditContext, type BlockEditApi } from "../contexts";
import { rewriteMacroOptions } from "../grammar/macroOptionsWrite";
import { MAX_BLOCK_TEXT_CHARS, TEXT_LENGTH_NOTICE } from "../grammar/textLimits";
import { tokenizeBlock } from "../grammar/tokenize";
import { acquireOutlineSession } from "../outline/outlineSessions";
import { sha256Hex } from "../replica/sha256";
import { subtreeHash } from "../replica/subtreeHash";
import { SyncContext } from "../sync/SyncProvider";
import { InlineSegments } from "./InlineSegments";
import { QueryBlock } from "./QueryBlock";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** A /api/query group of `items`, each `[uid, text]`. */
function group(n: number, name: string, items: [string, string][],
               extra: Partial<QueryGroup> = {}): QueryGroup {
  return { page_id: pageIdOf(n), page_title: canonicalTitleOf(name),
           items: items.map(([id, text]) => ({ uid: uidOf(id), text })),
           ...extra };
}

/** The records route's answer for results with no :: lines: one line record
 * per result, as the server maps a plain block, and the groups it then
 * carries for the blocks view. */
function linesOf(groups: QueryGroup[]): QueryRecordsPayload {
  const records = groups.flatMap((g) => g.items.map((it): QueryRecordModel => ({
    key: `l:${it.uid}`, kind: "line", page_id: g.page_id,
    page_title: g.page_title, uid: it.uid, row_title: it.text,
    result_uids: [it.uid], cells: {}, insert_parent_uid: it.uid,
    insert_before_order_idx: null, last_attr_order_idx: null,
  })));
  return { records, keys: [], total: records.length, groups };
}

const recordsUrl = (enc: string) => `/api/query/records?${enc}`;

const EXPR = "{and: [[Generative Models]] [[Link]]}";
const ENC = new URLSearchParams({ expr: EXPR }).toString();
const EXPR_A = "{and: [[Alpha]]}";
const ENC_A = new URLSearchParams({ expr: EXPR_A }).toString();
const EXPR_B = "{and: [[Beta]]}";
const ENC_B = new URLSearchParams({ expr: EXPR_B }).toString();

function renderExpr(expr: string) {
  return render(<MemoryRouter><QueryBlock expr={expr} /></MemoryRouter>);
}

it("renders more than seventy results from one request without show more", async () => {
  const items = Array.from({ length: 71 }, (_, i): [string, string] =>
    [`uid_q${i}`, `result ${i}`]);
  const groups = [group(6, "Generative Models", items)];
  const fetchMock = stubFetch([
    [recordsUrl(ENC), linesOf(groups)],
    [`/api/query?${ENC}`, { groups, total: items.length }],
  ]);

  renderExpr(EXPR);

  expect(await screen.findByText("result 70")).toBeInTheDocument();
  expect(screen.getByText("71 of 71 results")).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock).toHaveBeenCalledWith(recordsUrl(ENC), READ_INIT);
  expect(screen.queryByRole("button", { name: /show more/i })).toBeNull();
});

it("InlineSegments renders query segments as live QueryBlocks", async () => {
  stubFetch([[recordsUrl(ENC), linesOf([])],
             [`/api/query?${ENC}`, { groups: [], total: 0 }]]);
  render(
    <MemoryRouter>
      <InlineSegments segments={tokenizeBlock(`{{[[query]]: ${EXPR}}}`)} />
    </MemoryRouter>,
  );
  expect(await screen.findByText("0 of 0 results")).toBeInTheDocument();
  expect(screen.getByText(`query: ${EXPR}`)).toBeInTheDocument();
});

it("asks the server for the expression without the macro's options", async () => {
  const fetchMock = stubFetch([
    [recordsUrl(ENC), linesOf([])],
    [`/api/query?${ENC}`, { groups: [], total: 0 }]]);
  const text = `{{query: ${EXPR} | view: blocks | sort: Title asc}}`;
  render(
    <MemoryRouter>
      <InlineSegments segments={tokenizeBlock(text)} />
    </MemoryRouter>,
  );
  expect(await screen.findByText("0 of 0 results")).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledWith(recordsUrl(ENC), READ_INIT);
  await vi.waitFor(() => expect(fetchMock)
    .toHaveBeenCalledWith(`/api/query?${ENC}`, READ_INIT));
});

it("caps nested query recursion with an inert placeholder and no extra fetch", async () => {
  const groups = [group(9, "Self", [["uid_r1", `see {{query: ${EXPR}}}`]])];
  const fetchMock = stubFetch([
    [recordsUrl(ENC), linesOf(groups)],
    [`/api/query?${ENC}`, { groups, total: 1 }],
  ]);
  render(<MemoryRouter><QueryBlock expr={EXPR} depth={1} /></MemoryRouter>);
  expect(await screen.findByText("1 of 1 results")).toBeInTheDocument();
  // The nested query inside the result item sits at the cap: inert, no fetch.
  expect(await screen.findByText(`{{query: ${EXPR}}}`)).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

const BETA = [group(2, "Beta page", [["beta01", "recovered"]])];
const ALPHA = [group(1, "Alpha page", [["alpha01", "a"]])];

/** Answers each URL prefix with its response, or the promise given. */
function routeFetch(routes: [string, Response | Promise<Response>][]) {
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    const hit = routes.find(([prefix]) => url.startsWith(prefix));
    if (!hit) throw new Error(`unexpected url ${url}`);
    return Promise.resolve(hit[1]);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

it("clears the current error when a changed expression succeeds", async () => {
  routeFetch([
    [recordsUrl(ENC_A), jsonResponse({ detail: "boom" }, 500)],
    [recordsUrl(ENC_B), jsonResponse(linesOf(BETA))],
    [`/api/query?${ENC_B}`, jsonResponse({ groups: BETA, total: 1 })],
  ]);

  const { rerender } = renderExpr(EXPR_A);
  expect(await screen.findByText(/500/)).toBeInTheDocument();

  rerender(
    <MemoryRouter>
      <QueryBlock expr={EXPR_B} />
    </MemoryRouter>,
  );

  expect(await screen.findByText("recovered")).toBeInTheDocument();
  expect(screen.queryByText(/500/)).toBeNull();
});

it("shows the server's 400 as an error state", async () => {
  vi.stubGlobal("fetch", vi.fn(async () =>
    new Response(JSON.stringify({ detail: "bad query" }), { status: 400 })));
  render(<MemoryRouter><QueryBlock expr="{nonsense" /></MemoryRouter>);
  expect(await screen.findByText(/400/)).toBeInTheDocument();
});

// --- out-of-order / concurrency ---

it("keeps only the current expr's results when a superseded expr resolves late", async () => {
  const a = defer<Response>();
  const b = defer<Response>();
  const fetchMock = routeFetch([
    [recordsUrl(ENC_A), a.promise], [recordsUrl(ENC_B), b.promise],
    [`/api/query?${ENC_A}`, jsonResponse({ groups: ALPHA, total: 1 })],
    [`/api/query?${ENC_B}`, jsonResponse({ groups: BETA, total: 1 })],
  ]);

  const { rerender } = renderExpr(EXPR_A);
  await vi.waitFor(() => expect(fetchMock)
    .toHaveBeenCalledWith(recordsUrl(ENC_A), READ_INIT));
  rerender(<MemoryRouter><QueryBlock expr={EXPR_B} /></MemoryRouter>);

  // The obsolete expr's own fetch is still in flight when the current one
  // settles first.
  b.resolve(jsonResponse(linesOf(BETA)));
  expect(await screen.findByText("Beta page")).toBeInTheDocument();

  // The obsolete expr's response arrives late; it must not overwrite the
  // current state.
  await act(async () => {
    a.resolve(jsonResponse(linesOf(ALPHA)));
    await Promise.resolve();
  });
  expect(screen.queryByText("Alpha page")).toBeNull();
  expect(screen.getByText("Beta page")).toBeInTheDocument();
});

it("ignores a stale generation's rejection while the current generation is still pending", async () => {
  const a = defer<Response>();
  const b = defer<Response>();
  const fetchMock = routeFetch([
    [recordsUrl(ENC_A), a.promise], [recordsUrl(ENC_B), b.promise],
    [`/api/query?${ENC_B}`, jsonResponse({ groups: BETA, total: 1 })],
  ]);

  const { rerender } = renderExpr(EXPR_A);
  await vi.waitFor(() => expect(fetchMock)
    .toHaveBeenCalledWith(recordsUrl(ENC_A), READ_INIT));
  rerender(<MemoryRouter><QueryBlock expr={EXPR_B} /></MemoryRouter>);

  // The obsolete expr's request fails while the current expr's own request is
  // still pending.
  await act(async () => {
    a.reject(new Error("stale network failure"));
    await Promise.resolve().then(() => Promise.resolve());
  });
  expect(screen.queryByText(/stale network failure/)).toBeNull();

  b.resolve(jsonResponse(linesOf(BETA)));
  expect(await screen.findByText("Beta page")).toBeInTheDocument();
  expect(screen.queryByText(/stale network failure/)).toBeNull();
});

it("a nested result shows its parent line as a link", async () => {
  const groups = [group(3, "Papers", [], {
    ancestor_texts: ["Some Paper"], ancestor_uids: [uidOf("abcdef123")],
    items: [{ uid: uidOf("uid_n1"), text: "nested result", ancestors: [0] }],
  })];
  stubFetch([
    [recordsUrl(ENC), linesOf(groups)],
    [`/api/query?${ENC}`, { groups, total: 1 }],
  ]);
  function Probe() {
    const l = useLocation();
    return <div data-testid="loc">{l.pathname + l.hash}</div>;
  }
  render(<MemoryRouter><QueryBlock expr={EXPR} /><Probe /></MemoryRouter>);
  const crumb = await screen.findByText("Some Paper");
  expect(crumb).toHaveClass("query-crumb");
  const item = screen.getByText("nested result");
  expect(item).toHaveClass("query-item");
  expect(item.firstElementChild).toContainElement(crumb);
  fireEvent.click(crumb);
  expect(screen.getByTestId("loc")).toHaveTextContent("/page/Papers#abcdef123");
});

// --- tables, cards, writes and Save ---

const BOOK = "{and: [[Book]]}";
const BOOK_ENC = new URLSearchParams({ expr: BOOK }).toString();

function bookCell(id: string, text: string,
                  extra: Partial<RecordCell> = {}): RecordCell {
  const at = text.indexOf("::") + 2;
  return { uid: uidOf(id), key_raw: text.slice(0, at - 2), text,
           value: text.slice(at).trimStart(), value_start: at,
           ...extra };
}

function bookRecord(key: string, name: string, cells: Record<string, RecordCell>,
                    extra: Partial<QueryRecordModel> = {}): QueryRecordModel {
  return { key, kind: "page", page_id: pageIdOf(1),
           page_title: canonicalTitleOf(name), uid: null, row_title: name,
           result_uids: [uidOf(`res_${key.slice(2)}`)], cells,
           insert_parent_uid: null, insert_before_order_idx: null,
           last_attr_order_idx: orderIdxOf(2), ...extra };
}

const ALPHA_BOOK = bookRecord("p:alpha", "Book/Alpha", {
  Author: bookCell("aauthor1", "Author:: Xavier",
                   { extra_uids: [uidOf("aauthor2")] }),
  "Reading Status": bookCell("astatus1", "Reading Status:: Read"),
  Published: bookCell("apub01", "Published:: 2020"),
});
const BETA_BOOK = bookRecord("p:beta", "Book/Beta", {
  Author: bookCell("bauthor1", "author:: Yolanda", { child_count: 3 }),
  Publication: bookCell("bpub01", "Publication:: 2017"),
});
const stat = (name: string, count: number): KeyStat =>
  ({ key: canonicalTitleOf(name), label: name, count });
const BOOK_KEYS = [stat("Author", 2), stat("Reading Status", 1),
                   stat("Published", 1), stat("Publication", 1),
                   stat("Format", 0)];
const BOOKS = { records: [ALPHA_BOOK, BETA_BOOK], keys: BOOK_KEYS, total: 2 };
const BOOK_GROUPS = [
  group(1, "Book/Alpha", [["res_alpha", "Type:: [[Book]]"]]),
  group(2, "Book/Beta", [["res_beta", "Type:: [[Book]]"]]),
];

function stubBooks(records: object = BOOKS) {
  return stubFetch([
    [recordsUrl(BOOK_ENC), records],
    [`/api/query?${BOOK_ENC}`, { groups: BOOK_GROUPS, total: 2 }],
  ]);
}

function editApi(text: string): BlockEditApi {
  return { toggleTodo: vi.fn(), text, setText: vi.fn(() => true), editAsText: vi.fn() };
}

/** The query as a block's text renders it, inside an editable block unless
 * `edit` is null. */
function Probe() {
  const l = useLocation();
  return <div data-testid="loc">{l.pathname + l.hash}</div>;
}

function renderBlock(text: string,
                     { edit = editApi(text), sync = makeSync(), onHostClick }:
    { edit?: BlockEditApi | null; sync?: SyncFake;
      onHostClick?: () => void } = {}) {
  const tree = (s: SyncFake) => (
    <SyncContext.Provider value={s}>
      <MemoryRouter>
        <BlockEditContext.Provider value={edit}>
          <div onClick={onHostClick}>
            <InlineSegments segments={tokenizeBlock(text)} />
          </div>
        </BlockEditContext.Provider>
        <Probe />
      </MemoryRouter>
    </SyncContext.Provider>);
  const view = render(tree(sync));
  /** The same block under another sync status, as a connection change
   * re-renders it. */
  const setSync = (next: SyncFake) => view.rerender(tree(next));
  return { ...view, edit, sync, setSync };
}

function headerIndex(label: string): number {
  return screen.getAllByRole("columnheader").findIndex((th) =>
    within(th).queryByRole("button", { name: label }) !== null);
}

function cellOf(rowTitle: string, label: string): HTMLElement {
  const row = screen.getAllByRole("row").find((tr) =>
    within(tr).queryByText(rowTitle) !== null)!;
  return within(row).getAllByRole("cell")[headerIndex(label)]!;
}

function editor(): HTMLTextAreaElement {
  return document.querySelector("textarea.cell-editor") as HTMLTextAreaElement;
}

function rowTitles(): string[] {
  return screen.getAllByRole("row").slice(1).map((tr) =>
    within(tr).getAllByRole("cell")[0]!.textContent ?? "");
}

const filterBox = () => screen.getByRole("searchbox", { name: "Filter" });

describe("query views", () => {
  it("shows a table by default when any record has :: lines", async () => {
    stubBooks();
    renderBlock(`{{query: ${BOOK}}}`);
    expect(await screen.findByRole("table")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Table" }))
      .toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByText("Type:: [[Book]]")).toBeNull();
  });

  it("shows blocks by default when no record has :: lines", async () => {
    stubBooks({ ...BOOKS, records: [bookRecord("p:alpha", "Book/Alpha", {})],
                keys: [], total: 1 });
    renderBlock(`{{query: ${BOOK}}}`);
    expect(await screen.findByText("Book/Beta")).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getByRole("button", { name: "Blocks" }))
      .toHaveAttribute("aria-pressed", "true");
  });

  it("counts rows against every record, and filters by column", async () => {
    stubBooks();
    renderBlock(`{{query: ${BOOK}}}`);
    expect(await screen.findByText("2 of 2 results")).toBeInTheDocument();
    fireEvent.change(filterBox(), { target: { value: "author:x" } });
    expect(screen.getByText("1 of 2 results")).toBeInTheDocument();
    expect(rowTitles()).toEqual(["Book/Alpha"]);
  });

  it("sorts on a header click without touching the outline", async () => {
    stubBooks();
    const { edit, sync } = renderBlock(`{{query: ${BOOK}}}`);
    await screen.findByRole("table");
    const author = screen.getByRole("button", { name: "Author" });
    fireEvent.click(author);
    expect(rowTitles()).toEqual(["Book/Alpha", "Book/Beta"]);
    fireEvent.click(author);
    expect(rowTitles()).toEqual(["Book/Beta", "Book/Alpha"]);
    expect(edit!.setText).not.toHaveBeenCalled();
    expect(sync.sent).toEqual([]);
  });

  it("shows the same rows and filter as cards, read-only", async () => {
    stubBooks();
    const host = vi.fn();
    renderBlock(`{{query: ${BOOK}}}`, { onHostClick: host });
    await screen.findByRole("table");
    fireEvent.change(filterBox(), { target: { value: "author:y" } });
    fireEvent.click(screen.getByRole("button", { name: "Cards" }));
    expect(screen.queryByRole("table")).toBeNull();
    const cards = screen.getAllByRole("article");
    expect(cards).toHaveLength(1);
    expect(within(cards[0]!).getByText("Book/Beta")).toBeInTheDocument();
    expect(within(cards[0]!).getByText("Publication")).toBeInTheDocument();
    expect(within(cards[0]!).getByText("2017")).toBeInTheDocument();
    fireEvent.click(within(cards[0]!).getByText("2017"));
    expect(editor()).toBeNull();
    expect(host).not.toHaveBeenCalled();
    expect(screen.getByText("1 of 2 results")).toBeInTheDocument();
  });

  it("clears a failed blocks fetch once one succeeds", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith(recordsUrl(BOOK_ENC))) return Promise.resolve(jsonResponse(BOOKS));
      calls += 1;
      return Promise.resolve(calls === 1 ? jsonResponse({ detail: "boom" }, 500)
        : jsonResponse({ groups: BOOK_GROUPS, total: 2 }));
    }));
    const { setSync } = renderBlock(`{{query: ${BOOK} | view: blocks}}`);
    expect(await screen.findByText(/500/)).toBeInTheDocument();
    setSync(makeSync("connected", { resyncGeneration: 1 }));
    expect(await screen.findByText("Book/Beta")).toBeInTheDocument();
    expect(screen.queryByText(/500/)).toBeNull();
  });

  it("filters the blocks view through each result's record", async () => {
    stubBooks();
    renderBlock(`{{query: ${BOOK} | view: blocks}}`);
    expect(await screen.findByText("Book/Beta")).toBeInTheDocument();
    fireEvent.change(filterBox(), { target: { value: "author:x" } });
    expect(screen.queryByText("Book/Beta")).toBeNull();
    expect(screen.getByText("Book/Alpha")).toBeInTheDocument();
  });

  it("links a line record's text to the line and its source to the page", async () => {
    stubBooks({ records: [bookRecord("l:xline", "Reading List", {
      Status: bookCell("lstatus", "Status:: Read"),
    }, { kind: "line", uid: uidOf("linex1234"), row_title: "Some line",
         insert_parent_uid: uidOf("linex1234") })],
                keys: [stat("Status", 1)], total: 1 });
    renderBlock(`{{query: ${BOOK}}}`);
    fireEvent.click(await screen.findByRole("link", { name: "Some line" }));
    expect(screen.getByTestId("loc"))
      .toHaveTextContent("/page/Reading%20List#linex1234");
    expect(screen.getByText(/line on/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("link", { name: "Reading List" }));
    expect(screen.getByTestId("loc")).toHaveTextContent(/^\/page\/Reading%20List$/);
  });

  it("renders a line record's markup in the table and on cards", async () => {
    const MARKED = "[Using LLMs](https://example.org/x) for #LLM";
    stubBooks({ records: [bookRecord("l:xline", "AI in Research", {
      Status: bookCell("lstatus", "Status:: Read"),
    }, { kind: "line", uid: uidOf("linex1234"), row_title: MARKED,
         insert_parent_uid: uidOf("linex1234") })],
                keys: [stat("Status", 1)], total: 1 });
    renderBlock(`{{query: ${BOOK}}}`);
    await screen.findByRole("table");
    const check = () => {
      expect(screen.queryByText(/\]\(https/)).toBeNull();
      expect(screen.getByRole("link", { name: "Using LLMs" }))
        .toHaveAttribute("href", "https://example.org/x");
      expect(screen.getByRole("link", { name: "#LLM" })).toBeInTheDocument();
    };
    check();
    fireEvent.click(screen.getByText(/for/));
    expect(screen.getByTestId("loc"))
      .toHaveTextContent("/page/AI%20in%20Research#linex1234");
    fireEvent.click(screen.getByRole("button", { name: "Cards" }));
    check();
  });

  it("badges a key held twice and a value with children", async () => {
    stubBooks();
    renderBlock(`{{query: ${BOOK}}}`);
    await screen.findByRole("table");
    expect(within(cellOf("Book/Alpha", "Author")).getByText("2 lines"))
      .toBeInTheDocument();
    expect(within(cellOf("Book/Beta", "Author")).getByText("+3 lines"))
      .toBeInTheDocument();
  });

  it("gives results in the blocks view no edit access to the host", async () => {
    const groups = [group(1, "Todo page", [["todo01", "{{[[TODO]]}} task"]])];
    stubFetch([[recordsUrl(BOOK_ENC), linesOf(groups)],
               [`/api/query?${BOOK_ENC}`, { groups, total: 1 }]]);
    renderBlock(`{{query: ${BOOK}}}`);
    expect(await screen.findByRole("checkbox", { name: "TODO" })).toBeDisabled();
  });
});

describe("column menu", () => {
  async function openMenu(label: string) {
    await screen.findByRole("table");
    fireEvent.click(screen.getByRole("button", { name: `${label} column menu` }));
    return screen.getByRole("menu", { name: "Column actions" });
  }

  it("hides, adds and moves columns, and Save writes them", async () => {
    stubBooks();
    const text = `{{query: ${BOOK}}}`;
    const { edit } = renderBlock(text);
    let menu = await openMenu("Publication");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Hide column" }));
    expect(headerIndex("Publication")).toBe(-1);
    menu = await openMenu("Author");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Format" }));
    expect(headerIndex("Format")).toBe(4);
    menu = await openMenu("Format");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Move left" }));
    expect(headerIndex("Format")).toBe(3);
    menu = await openMenu("Author");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Move right" }));
    expect(headerIndex("Author")).toBe(2);
    fireEvent.click(screen.getByRole("button", { name: "Save this view" }));
    expect(edit!.setText).toHaveBeenCalledWith(rewriteMacroOptions(text,
      [0, text.length],
      { columns: ["Reading Status", "Author", "Format", "Published"] }));
  });

  it("will not hide the last column", async () => {
    stubBooks();
    renderBlock(`{{query: ${BOOK} | columns: Author}}`);
    const menu = await openMenu("Author");
    expect(within(menu).getByRole("menuitem", { name: "Hide column" }))
      .toBeDisabled();
  });

  it("closes on Escape pressed inside it", async () => {
    stubBooks();
    renderBlock(`{{query: ${BOOK}}}`);
    await openMenu("Author");
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("menu", { name: "Column actions" }))
      .not.toBeInTheDocument();
  });

  it("moves focus on ArrowDown pressed inside it", async () => {
    stubBooks();
    renderBlock(`{{query: ${BOOK}}}`);
    const menu = await openMenu("Author");
    const items = within(menu).getAllByRole("menuitem")
      .filter((b) => !(b as HTMLButtonElement).disabled);
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(items[0]!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[1]);
  });
});

describe("saving the view", () => {
  it("Save writes the options into the host's text, Reset restores them", async () => {
    stubBooks();
    const text = `> see {{query: ${BOOK} | filter: kind}}`;
    const { edit } = renderBlock(text);
    await screen.findByText("✓ saved view");
    expect(filterBox()).toHaveValue("kind");
    fireEvent.change(filterBox(), { target: { value: "author:x" } });
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(filterBox()).toHaveValue("kind");
    fireEvent.change(filterBox(), { target: { value: "author:x" } });
    fireEvent.click(screen.getByRole("button", { name: "Save this view" }));
    expect(edit!.setText).toHaveBeenCalledWith(rewriteMacroOptions(text,
      [6, text.length], { filter: "author:x" }));
    expect(screen.getByText("✓ saved view")).toBeInTheDocument();
  });

  it("a Save the outline refuses leaves the view unsaved", async () => {
    stubBooks();
    const text = `{{query: ${BOOK}}}`;
    const edit = { ...editApi(text), setText: vi.fn(() => false) };
    renderBlock(text, { edit });
    await screen.findByRole("table");
    fireEvent.change(filterBox(), { target: { value: "kind" } });
    fireEvent.click(screen.getByRole("button", { name: "Save this view" }));
    expect(edit.setText).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("✓ saved view")).toBeNull();
    expect(screen.getByRole("button", { name: "Save this view" })).toBeInTheDocument();
  });

  it("refuses a filter holding [[ and writes nothing", async () => {
    stubBooks();
    const { edit } = renderBlock(`{{query: ${BOOK}}}`);
    await screen.findByRole("table");
    fireEvent.change(filterBox(), { target: { value: "[[Kin" } });
    expect(screen.getByText(/cannot contain '\[\['/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save this view" })).toBeNull();
    expect(edit!.setText).not.toHaveBeenCalled();
  });

  it("refuses when the host's text does not hold this query", async () => {
    stubBooks();
    const { edit } = renderBlock(`{{query: ${BOOK}}}`,
      { edit: editApi("((abcdefghi))") });
    await screen.findByRole("table");
    fireEvent.change(filterBox(), { target: { value: "kind" } });
    fireEvent.click(screen.getByRole("button", { name: "Save this view" }));
    expect(screen.getByText(/Can't find this query/)).toBeInTheDocument();
    expect(edit!.setText).not.toHaveBeenCalled();
  });

  it("Edit as text opens the host block", async () => {
    stubBooks();
    const { edit } = renderBlock(`{{query: ${BOOK}}}`);
    fireEvent.click(await screen.findByRole("button", { name: "Edit as text" }));
    expect(edit!.editAsText).toHaveBeenCalled();
  });
});

describe("without edit access", () => {
  it.each([
    ["outside an editable block", { edit: null }],
    ["offline", { sync: makeSync("reconnecting") }],
  ])("%s, no cell opens and nothing saves", async (_, opts) => {
    stubBooks();
    renderBlock(`{{query: ${BOOK}}}`, opts);
    await screen.findByRole("table");
    fireEvent.click(cellOf("Book/Alpha", "Reading Status"));
    expect(editor()).toBeNull();
    fireEvent.change(filterBox(), { target: { value: "kind" } });
    expect(screen.queryByRole("button", { name: "Save this view" })).toBeNull();
    expect(screen.getByRole("button", { name: "Reset" })).toBeInTheDocument();
  });

  it("offers Edit as text only inside an editable block", async () => {
    stubBooks();
    renderBlock(`{{query: ${BOOK}}}`, { edit: null });
    await screen.findByRole("table");
    expect(screen.queryByRole("button", { name: "Edit as text" })).toBeNull();
  });
});

describe("cell writes", () => {
  async function write(row: string, label: string, value: string) {
    fireEvent.click(cellOf(row, label));
    fireEvent.change(editor(), { target: { value } });
    fireEvent.keyDown(editor(), { key: "Enter" });
    await act(async () => { await Promise.resolve(); });
  }

  it("updates the line, names it, and Undo restores what it held", async () => {
    stubBooks();
    const { sync } = renderBlock(`{{query: ${BOOK}}}`);
    await screen.findByRole("table");
    await write("Book/Alpha", "Reading Status", "Unread");
    expect(sync.sent).toEqual([[{
      op: "update_text", uid: "astatus1", text: "Reading Status:: Unread",
      base_text_hash: sha256Hex("Reading Status:: Read"), page_title: "Book/Alpha",
    }]]);
    expect(sync.tickets[0]!.scope).toEqual(["page", "Book/Alpha"]);
    expect(cellOf("Book/Alpha", "Reading Status")).toHaveTextContent("Unread");
    expect(screen.getByText(/Reading Status:: Unread written to Book\/Alpha/))
      .toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await act(async () => { await Promise.resolve(); });
    expect(sync.sent[1]).toEqual([{
      op: "update_text", uid: "astatus1", text: "Reading Status:: Read",
      base_text_hash: sha256Hex("Reading Status:: Unread"), page_title: "Book/Alpha",
    }]);
    expect(cellOf("Book/Alpha", "Reading Status")).toHaveTextContent(/^Read$/);
  });

  it("creates a missing line, and Undo deletes it", async () => {
    stubBooks();
    const { sync } = renderBlock(`{{query: ${BOOK}}}`);
    await screen.findByRole("table");
    await write("Book/Beta", "Reading Status", "Read");
    const create = sync.sent[0]![0]!;
    expect(create).toMatchObject({
      op: "create", page_title: "Book/Beta", parent_uid: null, order_idx: 3,
      text: "Reading Status:: Read" });
    expect(sync.tickets[0]!.scope).toEqual(["page", "Book/Beta"]);
    expect(cellOf("Book/Beta", "Reading Status")).toHaveTextContent("Read");
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(sync.sent[1]).toEqual([{
      op: "delete", uid: create.op === "create" ? create.uid : "",
      base_subtree_hash: subtreeHash([[
        create.op === "create" ? create.uid : "", "Reading Status:: Read"]]),
    }]);
    expect(cellOf("Book/Beta", "Reading Status")).toHaveTextContent(/^$/);
    await write("Book/Beta", "Reading Status", "Unread");
    expect(sync.sent[2]![0]).toMatchObject({ op: "create", order_idx: 3 });
  });

  it("warns before writing a column the record spells otherwise", async () => {
    stubBooks();
    renderBlock(`{{query: ${BOOK}}}`);
    await screen.findByRole("table");
    fireEvent.click(cellOf("Book/Beta", "Published"));
    expect(screen.getByText(/Publication::/)).toBeInTheDocument();
  });

  it("keeps an edited row in place, marked, until the view changes", async () => {
    stubBooks();
    renderBlock(`{{query: ${BOOK}}}`);
    await screen.findByRole("table");
    fireEvent.change(filterBox(), { target: { value: "-status:read" } });
    expect(rowTitles()).toEqual(["Book/Beta"]);
    await write("Book/Beta", "Reading Status", "Read");
    expect(screen.getByText("no longer matches")).toBeInTheDocument();
    expect(screen.getByText("0 of 2 results")).toBeInTheDocument();
    fireEvent.change(filterBox(), { target: { value: "-status:rea" } });
    expect(screen.queryByRole("row", { name: /Book\/Beta/ })).toBeNull();
  });

  /** Renders the books, with columns that do not follow the records, and
   * writes Alpha's status, which holds the rows in place; `resync` then
   * answers a reconnect with `records`. */
  async function writeAlphaStatus() {
    stubBooks();
    const sync = makeSync();
    const { setSync } = renderBlock(
      `{{query: ${BOOK} | columns: Author, Reading Status}}`, { sync });
    await screen.findByRole("table");
    await write("Book/Alpha", "Reading Status", "Unread");
    const resync = async (records: QueryRecordModel[], generation: number) => {
      stubBooks({ ...BOOKS, records, total: records.length });
      const later = makeSync("connected", { resyncGeneration: generation });
      later.enqueue = sync.enqueue;
      setSync(later);
      const n = records.length;
      await screen.findByText(`${n} of ${n} results`);
    };
    return { sync, resync };
  }

  it("keeps a held row a refetch drops, marked, with its open draft", async () => {
    const { sync, resync } = await writeAlphaStatus();
    fireEvent.click(cellOf("Book/Alpha", "Author"));
    fireEvent.change(editor(), { target: { value: "Xavier Q" } });
    await resync([BETA_BOOK], 1);
    expect(screen.getByText("Book/Alpha")).toBeInTheDocument();
    expect(screen.getByText("no longer matches")).toBeInTheDocument();
    expect(editor().value).toBe("Xavier Q");
    expect(sync.sent).toHaveLength(1);
    fireEvent.keyDown(editor(), { key: "Enter" });
    await act(async () => { await Promise.resolve(); });
    expect(sync.sent[1]).toEqual([expect.objectContaining({
      op: "update_text", uid: "aauthor1", text: "Author:: Xavier Q",
      base_text_hash: sha256Hex("Author:: Xavier") })]);
    expect(cellOf("Book/Alpha", "Author")).toHaveTextContent("Xavier Q");
    expect(cellOf("Book/Alpha", "Reading Status")).toHaveTextContent("Unread");
  });

  it("shows the record a later refetch returns for a held row", async () => {
    const { resync } = await writeAlphaStatus();
    await resync([BETA_BOOK], 1);
    const fresh = bookRecord("p:alpha", "Book/Alpha", {
      ...ALPHA_BOOK.cells,
      "Reading Status": bookCell("astatus1", "Reading Status:: Reading") });
    await resync([fresh, BETA_BOOK], 2);
    expect(cellOf("Book/Alpha", "Reading Status")).toHaveTextContent("Reading");
    expect(screen.queryByText("no longer matches")).toBeNull();
  });

  it("lets a held row go when the view changes", async () => {
    const { resync } = await writeAlphaStatus();
    await resync([BETA_BOOK], 1);
    fireEvent.change(filterBox(), { target: { value: "book" } });
    expect(screen.queryByText("Book/Alpha")).toBeNull();
    expect(screen.getByText("Book/Beta")).toBeInTheDocument();
  });

  it("an Undo undoes its own write when its press commits another cell", async () => {
    stubBooks();
    const { sync } = renderBlock(`{{query: ${BOOK}}}`);
    await screen.findByRole("table");
    await write("Book/Alpha", "Reading Status", "Unread");
    const undo = screen.getByRole("button", { name: "Undo" });
    fireEvent.click(cellOf("Book/Beta", "Reading Status"));
    fireEvent.change(editor(), { target: { value: "Read" } });
    fireEvent.mouseDown(undo);
    expect(sync.sent).toHaveLength(2);
    expect(undo).toBeInTheDocument();
    fireEvent.mouseUp(undo);
    fireEvent.click(undo);
    expect(sync.sent[2]).toEqual([expect.objectContaining({
      op: "update_text", uid: "astatus1", text: "Reading Status:: Read" })]);
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(screen.getByText(/Reading Status:: Read written to Book\/Beta/))
      .toBeInTheDocument();
  });

  it("a connection blip keeps an open cell, and its commit still queues", async () => {
    stubBooks();
    const sync = makeSync();
    const { setSync } = renderBlock(`{{query: ${BOOK}}}`, { sync });
    await screen.findByRole("table");
    fireEvent.click(cellOf("Book/Alpha", "Reading Status"));
    fireEvent.change(editor(), { target: { value: "Unr" } });
    const offline = makeSync("reconnecting");
    offline.enqueue = sync.enqueue;
    setSync(offline);
    expect(editor().value).toBe("Unr");
    expect(sync.sent).toEqual([]);
    fireEvent.change(editor(), { target: { value: "Unread" } });
    fireEvent.keyDown(editor(), { key: "Enter" });
    await act(async () => { await Promise.resolve(); });
    expect(sync.sent).toEqual([[expect.objectContaining({
      op: "update_text", text: "Reading Status:: Unread" })]]);
    fireEvent.click(cellOf("Book/Beta", "Reading Status"));
    expect(editor()).toBeNull();
  });

  it("shows a write from its enqueue, so a re-edit builds on it", async () => {
    stubBooks();
    const sync = makeSync();
    const enqueue = sync.enqueue;
    sync.enqueue = (ops, scope) => ({ ...enqueue(ops, scope),
                                      settled: new Promise(() => {}),
                                      delivered: new Promise(() => {}) });
    renderBlock(`{{query: ${BOOK}}}`, { sync });
    await screen.findByRole("table");
    await write("Book/Alpha", "Reading Status", "Unread");
    expect(cellOf("Book/Alpha", "Reading Status")).toHaveTextContent("Unread");
    await write("Book/Alpha", "Reading Status", "Read again");
    expect(sync.sent[1]).toEqual([expect.objectContaining({
      base_text_hash: sha256Hex("Reading Status:: Unread") })]);
    await write("Book/Beta", "Reading Status", "Read");
    await write("Book/Beta", "Reading Status", "Unread");
    expect(sync.sent[3]![0]!.op).toBe("update_text");
  });

  it("names the key as the page spells it", async () => {
    stubBooks();
    renderBlock(`{{query: ${BOOK}}}`);
    await screen.findByRole("table");
    await write("Book/Beta", "Author", "Zed");
    expect(screen.getByText("author:: Zed written to Book/Beta")).toBeInTheDocument();
  });

  it("a refused write holds no rows in place", async () => {
    stubBooks();
    const sync = makeSync();
    const { setSync } = renderBlock(`{{query: ${BOOK}}}`, { sync });
    await screen.findByRole("table");
    await write("Book/Alpha", "Reading Status", "x".repeat(MAX_BLOCK_TEXT_CHARS));
    const gamma = bookRecord("p:gamma", "Book/Gamma", {});
    stubBooks({ ...BOOKS, records: [ALPHA_BOOK, BETA_BOOK, gamma], total: 3 });
    const later = makeSync("connected", { resyncGeneration: 1 });
    later.enqueue = sync.enqueue;
    setSync(later);
    expect(await screen.findByText("Book/Gamma")).toBeInTheDocument();
  });

  it("names a write the queue refuses, and sends nothing", async () => {
    stubBooks();
    const sync = makeSync("connected", {
      enqueue: () => { throw new Error("queue disposed"); } });
    renderBlock(`{{query: ${BOOK}}}`, { sync });
    await screen.findByRole("table");
    await write("Book/Alpha", "Reading Status", "Unread");
    expect(screen.getByText(/queue disposed/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("keeps a write the queue failed to persist but still delivers", async () => {
    stubBooks();
    const sync = makeSync();
    const enqueue = sync.enqueue;
    sync.enqueue = (ops, scope) => ({
      ...enqueue(ops, scope),
      settled: Promise.resolve({ status: "failed", error: new Error("disk full") }),
      delivered: Promise.resolve({ status: "delivered" }),
    });
    renderBlock(`{{query: ${BOOK}}}`, { sync });
    await screen.findByRole("table");
    await write("Book/Alpha", "Reading Status", "Unread");
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByText(/failed/)).toBeNull();
    expect(screen.getByText(/Reading Status:: Unread written to Book\/Alpha/))
      .toBeInTheDocument();
    expect(cellOf("Book/Alpha", "Reading Status")).toHaveTextContent("Unread");
  });

  it("names a write the queue dropped, and leaves the cell as it was", async () => {
    stubBooks();
    const sync = makeSync();
    const enqueue = sync.enqueue;
    let drop!: (error: Error) => void;
    sync.enqueue = (ops, scope) => ({
      ...enqueue(ops, scope),
      delivered: new Promise((done) => {
        drop = (error) => done({ status: "failed", error });
      }),
    });
    renderBlock(`{{query: ${BOOK}}}`, { sync });
    await screen.findByRole("table");
    await write("Book/Alpha", "Reading Status", "Unread");
    expect(cellOf("Book/Alpha", "Reading Status")).toHaveTextContent("Unread");
    await act(async () => { drop(new Error("400 rejected")); });
    expect(screen.getByText(/write to Book\/Alpha failed: Error: 400 rejected/))
      .toBeInTheDocument();
    expect(cellOf("Book/Alpha", "Reading Status")).toHaveTextContent(/^Read$/);
  });

  it("refuses a value past the text limit without queueing it", async () => {
    stubBooks();
    const { sync } = renderBlock(`{{query: ${BOOK}}}`);
    await screen.findByRole("table");
    await write("Book/Alpha", "Reading Status", "x".repeat(MAX_BLOCK_TEXT_CHARS));
    expect(sync.sent).toEqual([]);
    expect(screen.getByText(TEXT_LENGTH_NOTICE)).toBeInTheDocument();
  });

  it("shows the write at once in an open copy of the page", async () => {
    stubBooks();
    const handle = acquireOutlineSession(rawTitleOf("Book/Alpha"), [
      block("astatus1", "Reading Status:: Read")]);
    try {
      renderBlock(`{{query: ${BOOK}}}`);
      await screen.findByRole("table");
      await write("Book/Alpha", "Reading Status", "Unread");
      expect(handle.getSnapshot().blocks[0]!.text).toBe("Reading Status:: Unread");
    } finally {
      handle.release();
    }
  });
});

describe("one request per default view", () => {
  const urls = (mock: ReturnType<typeof stubFetch>) =>
    mock.mock.calls.map(([u]) => String(u));

  it("shows a no-cells query's blocks from the records answer alone", async () => {
    const groups = [group(1, "Todo page", [["todo01", "write it up"]])];
    const mock = stubFetch([[recordsUrl(BOOK_ENC), linesOf(groups)]]);
    renderBlock(`{{query: ${BOOK}}}`);
    expect(await screen.findByText("write it up")).toBeInTheDocument();
    expect(urls(mock)).toEqual([recordsUrl(BOOK_ENC)]);
  });

  it("makes no /api/query request for a table query", async () => {
    const mock = stubBooks();
    renderBlock(`{{query: ${BOOK}}}`);
    await screen.findByRole("table");
    expect(urls(mock)).toEqual([recordsUrl(BOOK_ENC)]);
  });

  it("starts both requests at once for a saved blocks view over cells", async () => {
    const records = defer<Response>();
    const groups = defer<Response>();
    const mock = routeFetch([
      [recordsUrl(BOOK_ENC), records.promise],
      [`/api/query?${BOOK_ENC}`, groups.promise],
    ]);
    renderBlock(`{{query: ${BOOK} | view: blocks}}`);
    await vi.waitFor(() => expect(urls(mock)).toEqual(
      [recordsUrl(BOOK_ENC), `/api/query?${BOOK_ENC}`]));
    groups.resolve(jsonResponse({ groups: BOOK_GROUPS, total: 2 }));
    records.resolve(jsonResponse(BOOKS));
    expect(await screen.findByText("Book/Beta")).toBeInTheDocument();
    expect(urls(mock)).toHaveLength(2);
  });

  it("fetches the blocks on demand when the reader picks Blocks", async () => {
    const mock = stubBooks();
    renderBlock(`{{query: ${BOOK}}}`);
    await screen.findByRole("table");
    fireEvent.click(screen.getByRole("button", { name: "Blocks" }));
    expect(await screen.findByText("Book/Beta")).toBeInTheDocument();
    expect(urls(mock)).toEqual(
      [recordsUrl(BOOK_ENC), `/api/query?${BOOK_ENC}`]);
  });

  it("takes a resync's groups from the records answer without /api/query", async () => {
    const first = [group(1, "Todo page", [["todo01", "old result"]])];
    const later = [group(1, "Todo page", [["todo02", "new result"]])];
    const mock = stubFetch([[recordsUrl(BOOK_ENC), linesOf(first)]]);
    const { setSync } = renderBlock(`{{query: ${BOOK}}}`);
    expect(await screen.findByText("old result")).toBeInTheDocument();
    stubFetch([[recordsUrl(BOOK_ENC), linesOf(later)]]);
    setSync(makeSync("connected", { resyncGeneration: 1 }));
    expect(await screen.findByText("new result")).toBeInTheDocument();
    expect(screen.queryByText("old result")).toBeNull();
    expect(urls(mock)).toEqual([recordsUrl(BOOK_ENC)]);
  });

  it("does not let a slower /api/query overwrite the groups the records carried", async () => {
    const slow = defer<Response>();
    const older = [group(1, "Todo page", [["todo01", "old result"]])];
    const newer = [group(1, "Todo page", [["todo02", "new result"]])];
    // A saved blocks view starts /api/query with the records; the records
    // answer, newer, carries the groups and lands while it is pending.
    routeFetch([
      [recordsUrl(BOOK_ENC), jsonResponse(linesOf(newer))],
      [`/api/query?${BOOK_ENC}`, slow.promise],
    ]);
    renderBlock(`{{query: ${BOOK} | view: blocks}}`);
    expect(await screen.findByText("new result")).toBeInTheDocument();
    await act(async () => {
      slow.resolve(jsonResponse({ groups: older, total: 1 }));
      await Promise.resolve();
    });
    expect(screen.queryByText("old result")).toBeNull();
    expect(screen.getByText("new result")).toBeInTheDocument();
  });
});
