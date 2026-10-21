// onLinkLocalFile end to end in the outline: the picked file's attribute is
// spliced at the recorded offset, and a vanished block is a no-op.
import { act, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { expect, it, vi } from "vitest";
import type { BlockNode } from "../api/payloads";
import type { OutlineHandlers } from "../outline/handlers";
import { SyncContext } from "../sync/SyncProvider";
import { block, makeSync, orderIdxOf, canonicalTitleOf, uidOf } from "../test-helpers";
import { useOutline } from "../outline/useOutline";
import { ROUTER_FUTURE_FLAGS } from "../router";
import { EditableBlockTree } from "./EditableBlockTree";

const FILE = { path: "Papers/notes.zip", href: "/api/local/Papers/notes.zip" };

let handlers!: OutlineHandlers;
let outline!: ReturnType<typeof useOutline>;

function Page({ initial }: { initial: BlockNode[] }) {
  const o = useOutline(canonicalTitleOf("Page"), initial);
  outline = o;
  handlers = o.handlers;
  return (
    <EditableBlockTree blocks={o.blocks} focus={o.focus} selection={o.selection}
                       handlers={o.handlers} readOnly={o.readOnly} />
  );
}

function renderPage(text: string) {
  render(
    <SyncContext.Provider value={makeSync()}>
      <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
        <Page initial={[block("tuid-a", text, { order_idx: orderIdxOf(0) })]} />
      </MemoryRouter>
    </SyncContext.Provider>);
}

it("splices the Local copy attribute at the recorded offset", () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
  renderPage("before after");
  act(() => handlers.onLinkLocalFile(uidOf("tuid-a"), 7, FILE));
  expect(outline.blocks[0].text).toContain("Local copy:: [notes.zip](/api/local/Papers/notes.zip)");
  expect(outline.blocks[0].text.startsWith("before ")).toBe(true);
  expect(outline.blocks[0].text.endsWith("after")).toBe(true);
  expect(screen.getByRole("link", { name: "notes.zip" })).toBeInTheDocument();
});

it("does nothing and does not throw when the block no longer exists", () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
  renderPage("hello");
  expect(() => act(() => handlers.onLinkLocalFile(uidOf("tuid-gone"), 0, FILE))).not.toThrow();
  expect(outline.blocks[0].text).toBe("hello");
});
