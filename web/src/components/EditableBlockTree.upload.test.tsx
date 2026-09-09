// pkm-zrjc: the /upload pick gives up the block itself, so the uploaded
// image renders even when the native dialog does not blur the textarea.
import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { expect, it } from "vitest";
import type { BlockNode } from "../api/payloads";
import { SyncContext } from "../sync/SyncProvider";
import { block, makeSync, stubFetch } from "../test-helpers";
import { useOutline } from "../outline/useOutline";
import { ROUTER_FUTURE_FLAGS } from "../router";
import { EditableBlockTree } from "./EditableBlockTree";

const INFO = { sha256: "ab".repeat(32), filename: "cat.png",
               mime: "image/png", size: 3, url: `/assets/${"ab".repeat(32)}/cat.png` };

function Page({ initial }: { initial: BlockNode[] }) {
  const o = useOutline("Page", initial);
  return <EditableBlockTree blocks={o.blocks} focus={o.focus}
                            selection={o.selection} handlers={o.handlers}
                            readOnly={o.readOnly} />;
}

async function flush() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

it("the /upload pick gives up the block itself, so the uploaded image "
   + "renders even when the native dialog does not blur the textarea "
   + "(pkm-zrjc)", async () => {
  stubFetch([["/api/assets", INFO]]);
  const view = render(
    <SyncContext.Provider value={makeSync()}>
      <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
        <Page initial={[block("u1", "hello", { order_idx: 0 })]} />
      </MemoryRouter>
    </SyncContext.Provider>);

  fireEvent.click(screen.getByText(/hello/));
  const ta = screen.getByRole("textbox") as HTMLTextAreaElement;
  fireEvent.change(ta, { target: { value: "/upload" } });
  ta.setSelectionRange(7, 7);
  expect(screen.getByRole("option", { name: "upload file…" })).toBeInTheDocument();
  fireEvent.keyDown(ta, { key: "Enter" }); // pick /upload

  // No blur simulated here: the native file dialog does not reliably blur
  // the textarea, and the fix must not depend on it doing so.
  const input = screen.getByLabelText("Upload file") as HTMLInputElement;
  const file = new File(["x"], "cat.png", { type: "image/png" });
  await act(async () => {
    fireEvent.change(input, { target: { files: [file] } });
    await flush();
  });

  expect(screen.queryByRole("textbox")).toBeNull();
  const images = view.container.querySelectorAll("img.asset-image");
  expect(images).toHaveLength(1);
  expect(images[0]).toHaveAttribute("src", INFO.url);
});
