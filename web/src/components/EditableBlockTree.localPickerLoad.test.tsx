// The picker is a lazily loaded chunk: a failed load closes the open request
// with a notice, the next request retries, and Escape cancels a pending open.
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import type { OutlineHandlers } from "../outline/handlers";
import { ROUTER_FUTURE_FLAGS } from "../router";
import { block, jsonResponse, orderIdxOf, uidOf } from "../test-helpers";
import { EditableBlockTree } from "./EditableBlockTree";

const ctl = vi.hoisted(() => ({ fail: false }));

vi.mock("./LocalFilePicker", async () => {
  const real = await vi.importActual<typeof import("./LocalFilePicker")>("./LocalFilePicker");
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
  const h = new Proxy({}, { get: () => vi.fn() }) as OutlineHandlers;
  render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
      <EditableBlockTree blocks={[block("tuid-l1", "hello", { order_idx: orderIdxOf(0) })]}
                         focus={{ uid: uidOf("tuid-l1"), cursor: 0 }} handlers={h} readOnly={false} />
    </MemoryRouter>);
}

function runCommand() {
  const ta = screen.getByRole("textbox") as HTMLTextAreaElement;
  fireEvent.change(ta, { target: { value: "/link-l" } });
  ta.setSelectionRange(7, 7);
  fireEvent.keyDown(ta, { key: "Enter" });
}

it("a rejected chunk load closes the request and shows a notice", async () => {
  ctl.fail = true;
  mount();
  runCommand();
  expect(await screen.findByRole("status")).toHaveTextContent(NOTICE);
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("the next request after a failure retries the import and opens", async () => {
  ctl.fail = true;
  mount();
  runCommand();
  await screen.findByText(NOTICE);
  ctl.fail = false;
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
