// The tree-owned /link-local-file picker: it stays mounted through tree
// re-renders without re-running its dismissal hook, and it does not come
// back by itself after a read-only spell.
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import type { OutlineHandlers } from "../outline/handlers";
import { ROUTER_FUTURE_FLAGS } from "../router";
import { block, jsonResponse, orderIdxOf, uidOf } from "../test-helpers";
import { EditableBlockTree } from "./EditableBlockTree";

afterEach(() => vi.unstubAllGlobals());

const handlers = (): OutlineHandlers => new Proxy({}, { get: () => vi.fn() }) as OutlineHandlers;
const blocks = () => [block("tuid-p1", "hello", { order_idx: orderIdxOf(0) })];

function tree(h: OutlineHandlers, readOnly: boolean, focus: Parameters<typeof EditableBlockTree>[0]["focus"] = null) {
  return (
    <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
      <EditableBlockTree blocks={blocks()} focus={focus} handlers={h} readOnly={readOnly} />
    </MemoryRouter>
  );
}

async function openPicker(readOnly = false) {
  vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ files: [{ path: "Papers/a.pdf", href: "/l/a" }] })));
  const h = handlers();
  const view = render(tree(h, readOnly, { uid: uidOf("tuid-p1"), cursor: 0 }));
  const ta = screen.getByRole("textbox") as HTMLTextAreaElement;
  fireEvent.change(ta, { target: { value: "/link-l" } });
  ta.setSelectionRange(7, 7);
  fireEvent.keyDown(ta, { key: "Enter" });
  await screen.findByRole("listbox");
  return { h, view };
}

it("re-rendering the tree while the picker is open leaves focus where the user put it", async () => {
  const { h, view } = await openPicker();
  fireEvent.click(screen.getByRole("option", { name: "Papers" }));
  const crumb = screen.getByRole("button", { name: "Papers" });
  crumb.focus();
  view.rerender(tree(h, false));
  expect(crumb).toHaveFocus();
});

it("the picker does not come back after the tree goes read-only and editable again", async () => {
  const { h, view } = await openPicker();
  view.rerender(tree(h, true));
  expect(screen.queryByRole("dialog")).toBeNull();
  view.rerender(tree(h, false));
  expect(screen.queryByRole("dialog")).toBeNull();
});
