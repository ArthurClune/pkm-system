// The outline's pending draft is the one record of "the textarea holds
// unsaved text". Once it is flushed the textarea adopts the tree's text,
// even when the textarea outlived the flush (a /goodlinks splice landing
// while the user typed in the same block) or the flush sent nothing (typed
// then erased) while a remote edit landed.
import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import type { BlockOp } from "../api/ops";
import type { BlockNode } from "../api/payloads";
import { goodlinksAttribute } from "../outline/goodlinks";
import { useOutline } from "../outline/useOutline";
import { sha256Hex } from "../replica/sha256";
import { ROUTER_FUTURE_FLAGS } from "../router";
import { SyncContext } from "../sync/SyncProvider";
import { block, canonicalTitleOf, clientIdOf, jsonResponse, makeSync,
         orderIdxOf, uidOf, type SyncFake } from "../test-helpers";
import { EditableBlockTree } from "./EditableBlockTree";

const ID = "e4966bb2483b5c78f658398c0ae7b03f";
const LINK = { id: ID, title: "UML", url: "https://tratt.net/uml.html",
               added_at: "", created: false };
const RESOLVE = "/api/goodlinks/resolve";

function Page({ initial }: { initial: BlockNode[] }) {
  const o = useOutline(canonicalTitleOf("Draft Owner"), initial);
  return <EditableBlockTree blocks={o.blocks} focus={o.focus}
                            selection={o.selection} handlers={o.handlers}
                            readOnly={o.readOnly} />;
}

function renderPage(initial: BlockNode[]): SyncFake {
  const sync = makeSync();
  render(
    <SyncContext.Provider value={sync}>
      <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
        <Page initial={initial} />
      </MemoryRouter>
    </SyncContext.Provider>);
  return sync;
}

async function flush() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function blockTexts(): HTMLElement[] {
  return screen.getAllByText(
    (_, el) => el?.classList.contains("block-text") ?? false);
}

function textarea(): HTMLTextAreaElement {
  return screen.getByRole("textbox") as HTMLTextAreaElement;
}

function type(value: string) {
  const ta = textarea();
  fireEvent.change(ta, { target: { value } });
  ta.setSelectionRange(value.length, value.length);
}

function textOps(sync: SyncFake): Extract<BlockOp, { op: "update_text" }>[] {
  return sync.sent.flat().filter(
    (op): op is Extract<BlockOp, { op: "update_text" }> =>
      op.op === "update_text");
}

function remoteText(sync: SyncFake, uid: string, text: string) {
  act(() => sync.emit({
    client_id: clientIdOf("other"), ts: 1,
    ops: [{ op: "update_text", uid: uidOf(uid), text }],
  }));
}

it("a /goodlinks splice landing while the user retypes is shown, and the "
   + "next draft is typed over it", async () => {
  let release!: (r: Response) => void;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) =>
    String(input) === RESOLVE
      ? new Promise<Response>((res) => { release = res; })
      : jsonResponse({ detail: "not found" }, 404)));
  const sync = renderPage([
    block("tuid-p1", "[UML](https://tratt.net/uml.html)", {
      order_idx: orderIdxOf(0),
      children: [block("tuid-c1", "", { order_idx: orderIdxOf(0) })] }),
  ]);
  fireEvent.click(blockTexts()[1]);
  type("/goodlinks");
  fireEvent.keyDown(textarea(), { key: "Enter" }); // the pick blurs the block
  await act(async () => { await flush(); });
  expect(screen.queryByRole("textbox")).toBeNull();

  // back into the same block, typing while the resolve is in flight
  fireEvent.click(blockTexts()[1]);
  type("abc");
  await act(async () => {
    release(jsonResponse(LINK));
    await flush();
  });
  const spliced = textarea().value;
  expect(spliced).toContain(goodlinksAttribute(ID));
  expect(spliced).toContain("abc");

  type(`${spliced}d`);
  fireEvent.blur(textarea());
  const last = textOps(sync).at(-1);
  expect(last).toMatchObject({ uid: "tuid-c1", text: `${spliced}d`,
                               base_text_hash: sha256Hex(spliced) });
});

it("a remote edit after a typed-then-erased draft flushed is adopted", () => {
  vi.useFakeTimers();
  const sync = renderPage([block("tuid-a", "hello",
                                 { order_idx: orderIdxOf(0) })]);
  fireEvent.click(blockTexts()[0]);
  type("hellox");
  type("hello");
  act(() => { vi.advanceTimersByTime(600); });
  expect(sync.sent).toEqual([]);
  remoteText(sync, "tuid-a", "remote");
  expect(textarea().value).toBe("remote");
});

it("a remote edit under a typed-then-erased draft is adopted once the draft "
   + "flushes", () => {
  vi.useFakeTimers();
  const sync = renderPage([block("tuid-a", "hello",
                                 { order_idx: orderIdxOf(0) })]);
  fireEvent.click(blockTexts()[0]);
  type("hellox");
  type("hello");
  remoteText(sync, "tuid-a", "remote");
  expect(textarea().value).toBe("hello"); // the draft is still pending
  act(() => { vi.advanceTimersByTime(600); });
  expect(sync.sent).toEqual([]);
  expect(textarea().value).toBe("remote");

  type("remote!");
  fireEvent.blur(textarea());
  expect(textOps(sync)).toEqual([expect.objectContaining({
    text: "remote!", base_text_hash: sha256Hex("remote") })]);
});
