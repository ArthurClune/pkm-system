import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { useDismiss } from "../useDismiss";
import { useConfirm } from "./ConfirmDialog";
import { ImageOverlay } from "./ImageOverlay";

afterEach(() => {
  document.body.style.overflow = "";
});

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

/** jsdom has no native button activation, so emulate the browser: Enter on
 * a focused button clicks it unless a keydown listener prevented the
 * default. */
function pressEnterOn(element: HTMLElement) {
  element.focus();
  const notPrevented = fireEvent.keyDown(element, { key: "Enter" });
  if (notPrevented) fireEvent.click(element);
}

it("Enter on a focused Cancel button cancels instead of confirming", async () => {
  const onSettle = vi.fn();
  render(<Harness onSettle={onSettle} />);
  fireEvent.click(screen.getByText("open"));
  pressEnterOn(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(onSettle).toHaveBeenCalledWith(false));
  expect(onSettle).not.toHaveBeenCalledWith(true);
  expect(screen.queryByRole("alertdialog")).toBeNull();
});

it("Enter on the focused confirm button confirms once", async () => {
  const onSettle = vi.fn();
  render(<Harness onSettle={onSettle} />);
  fireEvent.click(screen.getByText("open"));
  pressEnterOn(screen.getByRole("button", { name: "Delete" }));
  await waitFor(() => expect(onSettle).toHaveBeenCalledWith(true));
  expect(onSettle).toHaveBeenCalledTimes(1);
});

it("a second confirm() settles the pending one as false", async () => {
  const answers: string[] = [];
  function Twice() {
    const { confirm, dialog } = useConfirm();
    return (
      <>
        <button type="button" onClick={() => {
          void confirm("First?").then((a) => answers.push(`first:${a}`));
        }}>first</button>
        <button type="button" onClick={() => {
          void confirm("Second?").then((a) => answers.push(`second:${a}`));
        }}>second</button>
        {dialog}
      </>
    );
  }
  render(<Twice />);
  fireEvent.click(screen.getByText("first"));
  fireEvent.click(screen.getByText("second"));
  await waitFor(() => expect(answers).toEqual(["first:false"]));
  expect(screen.getByText("Second?")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "OK" }));
  await waitFor(() =>
    expect(answers).toEqual(["first:false", "second:true"]));
});

it("Tab from the confirm button wraps to Cancel and Shift+Tab back", () => {
  render(<Harness onSettle={vi.fn()} />);
  fireEvent.click(screen.getByText("open"));
  const confirmButton = screen.getByRole("button", { name: "Delete" });
  const cancel = screen.getByRole("button", { name: "Cancel" });
  expect(confirmButton).toHaveFocus();
  expect(fireEvent.keyDown(window, { key: "Tab" })).toBe(false);
  expect(cancel).toHaveFocus();
  expect(fireEvent.keyDown(window, { key: "Tab", shiftKey: true }))
    .toBe(false);
  expect(confirmButton).toHaveFocus();
});

it("locks body scrolling while open and restores it after", async () => {
  document.body.style.overflow = "auto";
  const onSettle = vi.fn();
  render(<Harness onSettle={onSettle} />);
  fireEvent.click(screen.getByText("open"));
  expect(document.body.style.overflow).toBe("hidden");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(onSettle).toHaveBeenCalledWith(false));
  expect(document.body.style.overflow).toBe("auto");
});

it("returns focus to the element focused before it opened", async () => {
  const onSettle = vi.fn();
  render(<Harness onSettle={onSettle} />);
  const opener = screen.getByText("open");
  opener.focus();
  fireEvent.click(opener);
  expect(screen.getByRole("button", { name: "Delete" })).toHaveFocus();
  fireEvent.keyDown(window, { key: "Escape" });
  await waitFor(() => expect(onSettle).toHaveBeenCalledWith(false));
  expect(opener).toHaveFocus();
});

/** A transient surface under the dialog, closed by useDismiss's
 * document-level Escape. */
function DismissibleBelow({ onDismiss }: { onDismiss: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, onDismiss);
  return <div ref={ref}>menu</div>;
}

it("Escape does not reach a document-level useDismiss listener", async () => {
  const onSettle = vi.fn();
  const onDismiss = vi.fn();
  render(
    <>
      <DismissibleBelow onDismiss={onDismiss} />
      <Harness onSettle={onSettle} />
    </>,
  );
  fireEvent.click(screen.getByText("open"));
  fireEvent.keyDown(screen.getByRole("button", { name: "Delete" }),
                    { key: "Escape" });
  await waitFor(() => expect(onSettle).toHaveBeenCalledWith(false));
  expect(onDismiss).not.toHaveBeenCalled();
});

it("a second confirm() refocuses the confirm button", () => {
  function Twice() {
    const { confirm, dialog } = useConfirm();
    return (
      <>
        <button type="button" onClick={() => { void confirm("First?"); }}>
          first
        </button>
        <button type="button" onClick={() => {
          void confirm("Second?", { confirmLabel: "Yes" });
        }}>second</button>
        {dialog}
      </>
    );
  }
  render(<Twice />);
  fireEvent.click(screen.getByText("first"));
  screen.getByRole("button", { name: "Cancel" }).focus();
  fireEvent.click(screen.getByText("second"));
  expect(screen.getByText("Second?")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Yes" })).toHaveFocus();
});

it("a confirm over the image overlay answers Escape alone; scrolling stays locked until both close", () => {
  document.body.style.overflow = "auto";
  const onOverlayClose = vi.fn();
  function OverImage() {
    const { confirm, dialog } = useConfirm();
    return (
      <>
        <button type="button" onClick={() => { void confirm("Sure?"); }}>
          ask
        </button>
        <ImageOverlay src="/assets/a/p.png" alt="p" onClose={onOverlayClose}
                      onError={() => {}} />
        {dialog}
      </>
    );
  }
  const view = render(<OverImage />);
  fireEvent.click(screen.getByText("ask"));
  fireEvent.keyDown(screen.getByRole("button", { name: "OK" }),
                    { key: "Escape" });
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(onOverlayClose).not.toHaveBeenCalled();
  expect(document.body.style.overflow).toBe("hidden");

  fireEvent.keyDown(window, { key: "Escape" });
  expect(onOverlayClose).toHaveBeenCalledTimes(1);
  view.unmount();
  expect(document.body.style.overflow).toBe("auto");
});
