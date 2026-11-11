// A refused clipboard write shows the text to copy by hand in the outline's
// copy notice; the next copy clears it.
import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import type { BlockNode } from "../api/payloads";
import { SyncContext } from "../sync/SyncProvider";
import { block, makeSync, orderIdxOf, canonicalTitleOf, confirmYes, uidOf } from "../test-helpers";
import { useOutline, type Outline } from "../outline/useOutline";
import { EditableBlockTree } from "./EditableBlockTree";
import { noticeOf } from "../outline/notices";

let outline: Outline;

function Page({ initial, readOnly }: { initial: BlockNode[]; readOnly: boolean }) {
  const o = useOutline(canonicalTitleOf("Page"), initial, confirmYes);
  outline = o;
  const notice = noticeOf(o.notices, "copy");
  return (
    <>
      {notice !== null && <p role="alert">{notice}</p>}
      <EditableBlockTree blocks={o.blocks} focus={o.focus} selection={o.selection}
                         handlers={o.handlers} readOnly={readOnly || o.readOnly} />
    </>
  );
}

function tree() {
  return [
    block("tuid-a", "one", { order_idx: orderIdxOf(0) }),
    block("tuid-b", "two", { order_idx: orderIdxOf(1) }),
  ];
}

function mount(readOnly = false) {
  const view = render(
    <SyncContext.Provider value={makeSync()}>
      <MemoryRouter>
        <Page initial={tree()} readOnly={readOnly} />
      </MemoryRouter>
    </SyncContext.Provider>);
  return view.container;
}

function stubClipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText }, configurable: true,
  });
}

const refused = () => vi.fn(async (_: string): Promise<void> => {
  throw new Error("denied");
});

async function copyReference(container: HTMLElement) {
  fireEvent.click(container.querySelector('[data-uid="tuid-a"] .bullet') as HTMLElement);
  fireEvent.click(screen.getByRole("menuitem", { name: "Copy block reference" }));
  await act(async () => { await Promise.resolve(); });
}

async function copySelection(container: HTMLElement) {
  act(() => outline.handlers.onStartBlockSelection(uidOf("tuid-a"), "down"));
  const el = container.querySelector(".block-tree") as HTMLDivElement;
  fireEvent.keyDown(el, { key: "c", metaKey: true });
  await act(async () => { await Promise.resolve(); });
}

afterEach(() => vi.restoreAllMocks());

it("Copy block reference shows ((uid)) when the write is refused", async () => {
  stubClipboard(refused());
  await copyReference(mount());
  expect(screen.getByRole("alert")).toHaveTextContent("Copying failed. Select and copy it: ((tuid-a))");
});

it("Copy block reference shows the notice in a read-only outline", async () => {
  stubClipboard(refused());
  await copyReference(mount(true));
  expect(screen.getByRole("alert")).toHaveTextContent("((tuid-a))");
});

it("Cmd+C on a block selection shows the whole selection text when refused", async () => {
  stubClipboard(refused());
  await copySelection(mount());
  expect(noticeOf(outline.notices, "copy")).toBe("Copying failed. Select and copy it: one\ntwo");
});

it("a following successful copy clears the notice", async () => {
  stubClipboard(refused());
  const container = mount();
  await copyReference(container);
  expect(noticeOf(outline.notices, "copy")).not.toBeNull();
  stubClipboard(vi.fn(async () => undefined));
  await copyReference(container);
  expect(noticeOf(outline.notices, "copy")).toBeNull();
});
