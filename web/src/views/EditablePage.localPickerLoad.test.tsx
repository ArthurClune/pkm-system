// The picker is a lazily loaded chunk: a failed load closes the open request
// with a notice in the page's notice slot, the next request retries, and
// Escape cancels a pending open.
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { DndProvider } from "../dnd/DndContext";
import { ROUTER_FUTURE_FLAGS } from "../router";
import { block, canonicalTitleOf, jsonResponse, makeSync, orderIdxOf } from "../test-helpers";
import { SyncContext } from "../sync/SyncProvider";
import { EditablePage } from "../views/EditablePage";

const ctl = vi.hoisted(() => ({ fail: false }));

vi.mock("../components/LocalFilePicker", async () => {
  const real = await vi.importActual<typeof import("../components/LocalFilePicker")>("../components/LocalFilePicker");
  return {
    get LocalFilePicker() {
      if (ctl.fail) throw new Error("Failed to fetch dynamically imported module");
      return real.LocalFilePicker;
    },
  };
});

afterEach(() => {
  ctl.fail = false;
  vi.unstubAllGlobals();
});

const NOTICE = "Couldn't load the file picker; try again";

function mount() {
  vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ files: [{ path: "a.pdf", href: "/l/a" }] })));
  render(
    <SyncContext.Provider value={makeSync()}>
      <DndProvider>
        <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
          <EditablePage title={canonicalTitleOf("P")}
                        initial={[block("tuid-l1", "hello", { order_idx: orderIdxOf(0) })]} />
        </MemoryRouter>
      </DndProvider>
    </SyncContext.Provider>);
  fireEvent.click(screen.getByText("hello"));
}

function runCommand() {
  const ta = screen.getByRole("textbox") as HTMLTextAreaElement;
  fireEvent.change(ta, { target: { value: "/link-l" } });
  ta.setSelectionRange(7, 7);
  fireEvent.keyDown(ta, { key: "Enter" });
}

it("a rejected chunk load shows the notice in the page's top slot; Dismiss clears it", async () => {
  ctl.fail = true;
  mount();
  runCommand();
  const notice = await screen.findByRole("status");
  expect(notice).toHaveTextContent(NOTICE);
  expect(notice.parentElement!.firstElementChild).toBe(notice);
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
  expect(screen.queryByText(NOTICE)).toBeNull();
});

it("the next request after a failure retries the import and opens", async () => {
  ctl.fail = true;
  mount();
  runCommand();
  await screen.findByText(NOTICE);
  ctl.fail = false;
  fireEvent.click(document.querySelector(".block-text")!);
  runCommand();
  expect(await screen.findByRole("dialog")).toBeInTheDocument();
  expect(screen.queryByText(NOTICE)).toBeNull();
});

it("Escape before the chunk has loaded cancels the open", async () => {
  mount();
  runCommand();
  fireEvent.keyDown(window, { key: "Escape" });
  await new Promise((r) => setTimeout(r, 50));
  expect(screen.queryByRole("dialog")).toBeNull();
});
