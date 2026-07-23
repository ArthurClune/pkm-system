import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { useConfirm } from "./ConfirmDialog";

/** Small harness: exposes a button that opens the dialog and records the
 * resolved answer, standing in for a real caller like TopBar/PageTitle. */
function Harness({ onSettle }: { onSettle: (answer: boolean) => void }) {
  const { confirm, dialog } = useConfirm();
  return (
    <>
      <button type="button" onClick={() => { void confirm("Delete it?",
        { confirmLabel: "Delete", danger: true }).then(onSettle); }}>
        open
      </button>
      {dialog}
    </>
  );
}

it("renders nothing until confirm() is called", () => {
  render(<Harness onSettle={vi.fn()} />);
  expect(screen.queryByRole("alertdialog")).toBeNull();
});

it("shows the message and confirm/cancel controls once opened", () => {
  render(<Harness onSettle={vi.fn()} />);
  fireEvent.click(screen.getByText("open"));
  expect(screen.getByRole("alertdialog")).toBeInTheDocument();
  expect(screen.getByText("Delete it?")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
});

it("clicking the confirm button resolves true and closes the dialog", async () => {
  const onSettle = vi.fn();
  render(<Harness onSettle={onSettle} />);
  fireEvent.click(screen.getByText("open"));
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  await waitFor(() => expect(onSettle).toHaveBeenCalledWith(true));
  expect(screen.queryByRole("alertdialog")).toBeNull();
});

it("clicking Cancel resolves false and closes the dialog", async () => {
  const onSettle = vi.fn();
  render(<Harness onSettle={onSettle} />);
  fireEvent.click(screen.getByText("open"));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(onSettle).toHaveBeenCalledWith(false));
  expect(screen.queryByRole("alertdialog")).toBeNull();
});

it("Escape resolves false", async () => {
  const onSettle = vi.fn();
  render(<Harness onSettle={onSettle} />);
  fireEvent.click(screen.getByText("open"));
  fireEvent.keyDown(window, { key: "Escape" });
  await waitFor(() => expect(onSettle).toHaveBeenCalledWith(false));
  expect(screen.queryByRole("alertdialog")).toBeNull();
});

it("Enter resolves true", async () => {
  const onSettle = vi.fn();
  render(<Harness onSettle={onSettle} />);
  fireEvent.click(screen.getByText("open"));
  fireEvent.keyDown(window, { key: "Enter" });
  await waitFor(() => expect(onSettle).toHaveBeenCalledWith(true));
  expect(screen.queryByRole("alertdialog")).toBeNull();
});

it("clicking the overlay backdrop resolves false, clicking inside the card does not", async () => {
  const onSettle = vi.fn();
  render(<Harness onSettle={onSettle} />);
  fireEvent.click(screen.getByText("open"));
  fireEvent.click(screen.getByRole("alertdialog")); // inside the card
  expect(onSettle).not.toHaveBeenCalled();
  fireEvent.click(document.querySelector(".confirm-dialog-overlay")!);
  await waitFor(() => expect(onSettle).toHaveBeenCalledWith(false));
});

it("focuses the confirm button when the dialog opens (keyboard-first)", async () => {
  render(<Harness onSettle={vi.fn()} />);
  fireEvent.click(screen.getByText("open"));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Delete" })).toHaveFocus());
});

it("applies a danger styling class when danger is set", () => {
  render(<Harness onSettle={vi.fn()} />);
  fireEvent.click(screen.getByText("open"));
  expect(screen.getByRole("button", { name: "Delete" })).toHaveClass("btn-danger");
});
