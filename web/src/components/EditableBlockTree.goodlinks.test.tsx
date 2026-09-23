// /goodlinks end to end in the editor: pick resolves the parent's URL and
// splices the attribute into the child block through the draft path.
import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import type { BlockNode } from "../api/payloads";
import { SyncContext } from "../sync/SyncProvider";
import { block, jsonResponse, makeSync } from "../test-helpers";
import { useOutline } from "../outline/useOutline";
import { ROUTER_FUTURE_FLAGS } from "../router";
import { EditableBlockTree } from "./EditableBlockTree";

const ID = "e4966bb2483b5c78f658398c0ae7b03f";
const LINK = { id: ID, title: "UML", url: "https://tratt.net/uml.html", added_at: "", created: false };
const RESOLVE = "/api/goodlinks/resolve";

function Page({ initial }: { initial: BlockNode[] }) {
  const o = useOutline("Page", initial);
  return (
    <>
      {o.goodlinksNotice && <p role="status">{o.goodlinksNotice}</p>}
      <EditableBlockTree blocks={o.blocks} focus={o.focus} selection={o.selection}
                         handlers={o.handlers} readOnly={o.readOnly} />
    </>
  );
}

async function flush() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

afterEach(() => vi.unstubAllGlobals());

/** Stubs fetch so only the resolve call gets `respond`. Once the splice is
 * delivered the outline session re-reads the page; that read gets a 404,
 * as stubFetch answers it, which leaves the optimistic tree alone. */
function stubResolve(respond: (init?: RequestInit) => Response | Promise<Response>) {
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    String(input) === RESOLVE ? respond(init) : jsonResponse({ detail: "not found" }, 404));
  vi.stubGlobal("fetch", mock);
  return mock;
}

function resolveCalls(mock: ReturnType<typeof stubResolve>) {
  return mock.mock.calls.filter(([input]) => String(input) === RESOLVE);
}

function tree() {
  return [block("p1", "[UML](https://tratt.net/uml.html)", { order_idx: 0, children: [
    block("c1", "", { order_idx: 0 }),
  ] })];
}

function renderPage(initial: BlockNode[] = tree()) {
  render(
    <SyncContext.Provider value={makeSync()}>
      <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
        <Page initial={initial} />
      </MemoryRouter>
    </SyncContext.Provider>);
}

async function pickGoodlinks() {
  fireEvent.click(screen.getAllByText((_, el) => el?.classList.contains("block-text") ?? false)[1]);
  const ta = screen.getByRole("textbox") as HTMLTextAreaElement;
  fireEvent.change(ta, { target: { value: "/goodlinks" } });
  ta.setSelectionRange(10, 10);
  expect(screen.getByRole("option", { name: "link to goodlinks copy" })).toBeInTheDocument();
  // The pick commits (the block blurs) before the resolve settles, as a real
  // keydown does ahead of any network reply; nesting it in the async act
  // below would hold the blur's render until after the splice.
  fireEvent.keyDown(ta, { key: "Enter" });
  await act(async () => {
    await flush();
  });
}

it("resolves the parent's URL and splices the attribute into the child", async () => {
  const fetchMock = stubResolve((init) => {
    expect(JSON.parse(String(init?.body))).toEqual({ url: "https://tratt.net/uml.html", save: true });
    return jsonResponse(LINK);
  });
  renderPage();

  await pickGoodlinks();
  expect(resolveCalls(fetchMock)).toHaveLength(1);
  expect(String(fetchMock.mock.calls[0][0])).toBe(RESOLVE);
  // the block was given up by the pick, so the splice renders, not a textarea
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(screen.getByRole("button", { name: "Goodlinks" })).toBeInTheDocument();
  expect(screen.queryByRole("status")).toBeNull();
});

it("says Saved to Goodlinks when the resolve created the link", async () => {
  stubResolve(() => jsonResponse({ ...LINK, created: true }));
  renderPage();
  await pickGoodlinks();
  expect(screen.getByRole("status")).toHaveTextContent("Saved to Goodlinks");
  expect(screen.getByRole("button", { name: "Goodlinks" })).toBeInTheDocument();
});

it("reports a 503 as Goodlinks not running and inserts nothing", async () => {
  stubResolve(() => jsonResponse({ detail: "down" }, 503));
  renderPage();
  await pickGoodlinks();
  expect(screen.getByRole("status")).toHaveTextContent("Goodlinks is not running");
  expect(screen.queryByRole("button", { name: "Goodlinks" })).toBeNull();
});

it("says No URL nearby without calling the server when nothing links out", async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  renderPage([block("p1", "no links", { order_idx: 0, children: [block("c1", "", { order_idx: 0 })] })]);
  await pickGoodlinks();
  expect(fetchMock).not.toHaveBeenCalled();
  expect(screen.getByRole("status")).toHaveTextContent("No URL nearby");
});

it("splices into the requesting block even when focus has moved", async () => {
  let release!: (r: Response) => void;
  stubResolve(() => new Promise<Response>((res) => { release = res; }));
  renderPage();
  await pickGoodlinks();
  // user clicks the parent block while the resolve is in flight
  fireEvent.click(screen.getByText(/UML/));
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toContain("[UML]");
  await act(async () => {
    release(jsonResponse(LINK));
    await flush();
  });
  // parent keeps focus and its text; the child received the attribute
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("[UML](https://tratt.net/uml.html)");
  expect(screen.getByRole("button", { name: "Goodlinks" })).toBeInTheDocument();
});
