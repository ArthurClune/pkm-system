import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import { canonicalTitleOf, uidOf } from "../test-helpers";
import { useConfirm } from "./ConfirmDialog";
import { DeleteBlockedDialog } from "./DeleteBlockedDialog";
import type { DeleteBlocker } from "./deletePageCopy";

const BLOCKERS: DeleteBlocker[] = [
  { uid: uidOf("tuid-u1"), page_title: canonicalTitleOf("Queries"),
    excerpt: "{{query: [[Paper]]}}", text_length: 20, reason: "query" },
  { uid: uidOf("tuid-u2"), page_title: canonicalTitleOf("Notes"),
    excerpt: "Paper:: x", text_length: 9, reason: "attribute" },
];

afterEach(() => {
  document.body.style.overflow = "";
});

function renderDialog(onClose = vi.fn()) {
  render(
    <MemoryRouter>
      <button type="button">opener</button>
      <DeleteBlockedDialog heading="Can't delete" blockers={BLOCKERS}
                           onClose={onClose} />
    </MemoryRouter>,
  );
  return onClose;
}

it("focuses Close on open", () => {
  renderDialog();
  expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
});

it("Escape closes", () => {
  const onClose = renderDialog();
  fireEvent.keyDown(screen.getByRole("button", { name: "Close" }),
                    { key: "Escape" });
  expect(onClose).toHaveBeenCalledTimes(1);
});

it("Tab cycles through the blocker links and Close", () => {
  renderDialog();
  const close = screen.getByRole("button", { name: "Close" });
  const first = screen.getByRole("link", { name: "Queries" });
  fireEvent.keyDown(window, { key: "Tab" });
  expect(first).toHaveFocus();
  fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
  expect(close).toHaveFocus();
  // Focus that wandered behind the dialog is pulled back in.
  screen.getByRole("button", { name: "opener" }).focus();
  fireEvent.keyDown(window, { key: "Tab" });
  expect(first).toHaveFocus();
});

it("a blocker link closes the dialog", () => {
  const onClose = renderDialog();
  fireEvent.click(screen.getByRole("link", { name: "Notes" }));
  expect(onClose).toHaveBeenCalledTimes(1);
});

it("a backdrop click closes and a click inside the card does not", () => {
  const onClose = renderDialog();
  fireEvent.click(screen.getByRole("dialog"));
  expect(onClose).not.toHaveBeenCalled();
  fireEvent.click(document.querySelector(".confirm-dialog-overlay")!);
  expect(onClose).toHaveBeenCalledTimes(1);
});

function Openable({ open }: { open: boolean }) {
  return (
    <MemoryRouter>
      <button type="button">opener</button>
      {open && <DeleteBlockedDialog heading="Can't delete" blockers={BLOCKERS}
                                    onClose={() => {}} />}
    </MemoryRouter>
  );
}

it("locks body scrolling and returns focus to the element focused before it opened", () => {
  document.body.style.overflow = "auto";
  const view = render(<Openable open={false} />);
  const opener = screen.getByRole("button", { name: "opener" });
  opener.focus();
  view.rerender(<Openable open />);
  expect(document.body.style.overflow).toBe("hidden");
  expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
  view.rerender(<Openable open={false} />);
  expect(document.body.style.overflow).toBe("auto");
  expect(opener).toHaveFocus();
});

/** A confirm opened over the blocked dialog: the topmost answers Escape. */
function Nested({ onBlockedClose }: { onBlockedClose: () => void }) {
  const { confirm, dialog } = useConfirm();
  return (
    <MemoryRouter>
      <button type="button" onClick={() => { void confirm("Sure?"); }}>
        ask
      </button>
      <DeleteBlockedDialog heading="Can't delete" blockers={BLOCKERS}
                           onClose={onBlockedClose} />
      {dialog}
    </MemoryRouter>
  );
}

it("a confirm over it answers Escape alone; scrolling stays locked until both close", () => {
  document.body.style.overflow = "auto";
  const onBlockedClose = vi.fn();
  const view = render(<Nested onBlockedClose={onBlockedClose} />);
  fireEvent.click(screen.getByRole("button", { name: "ask" }));
  expect(screen.getByRole("button", { name: "OK" })).toHaveFocus();

  fireEvent.keyDown(screen.getByRole("button", { name: "OK" }),
                    { key: "Escape" });
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(onBlockedClose).not.toHaveBeenCalled();
  expect(screen.getByRole("dialog")).toBeInTheDocument();
  expect(document.body.style.overflow).toBe("hidden");

  fireEvent.keyDown(window, { key: "Escape" });
  expect(onBlockedClose).toHaveBeenCalledTimes(1);
  view.unmount();
  expect(document.body.style.overflow).toBe("auto");
});
