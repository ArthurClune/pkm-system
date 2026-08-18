import { fireEvent, render, screen } from "@testing-library/react";
import { useRef, useState } from "react";
import { expect, it, vi } from "vitest";
import { useDismiss } from "./useDismiss";

/** Minimal host for the hook: a box to click inside of, a sibling to click
 * outside of, and the options under test. */
function Host({ onDismiss, enabled, preventDefaultOnEscape }: {
  onDismiss: () => void;
  enabled?: boolean;
  preventDefaultOnEscape?: boolean;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useDismiss(ref, onDismiss, { enabled, preventDefaultOnEscape });
  return (
    <>
      <div ref={ref} data-testid="inside">inside</div>
      <div data-testid="outside">outside</div>
    </>
  );
}

it("dismisses on a mousedown outside the ref'd element", () => {
  const onDismiss = vi.fn();
  render(<Host onDismiss={onDismiss} />);
  fireEvent.mouseDown(screen.getByTestId("outside"));
  expect(onDismiss).toHaveBeenCalledTimes(1);
});

it("ignores a mousedown inside the ref'd element", () => {
  const onDismiss = vi.fn();
  render(<Host onDismiss={onDismiss} />);
  fireEvent.mouseDown(screen.getByTestId("inside"));
  expect(onDismiss).not.toHaveBeenCalled();
});

it("dismisses on Escape at the document level, ignoring other keys", () => {
  const onDismiss = vi.fn();
  render(<Host onDismiss={onDismiss} />);
  fireEvent.keyDown(document, { key: "Enter" });
  fireEvent.keyDown(document, { key: "Tab" });
  expect(onDismiss).not.toHaveBeenCalled();
  fireEvent.keyDown(document, { key: "Escape" });
  expect(onDismiss).toHaveBeenCalledTimes(1);
});

it("leaves Escape's default action alone unless asked to prevent it", () => {
  render(<Host onDismiss={vi.fn()} />);
  const plain = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
  document.dispatchEvent(plain);
  expect(plain.defaultPrevented).toBe(false);
});

it("prevents Escape's default action when preventDefaultOnEscape is set", () => {
  render(<Host onDismiss={vi.fn()} preventDefaultOnEscape />);
  const prevented = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
  document.dispatchEvent(prevented);
  expect(prevented.defaultPrevented).toBe(true);
});

it("registers nothing while disabled", () => {
  const onDismiss = vi.fn();
  render(<Host onDismiss={onDismiss} enabled={false} />);
  fireEvent.mouseDown(screen.getByTestId("outside"));
  fireEvent.keyDown(document, { key: "Escape" });
  expect(onDismiss).not.toHaveBeenCalled();
});

it("starts and stops listening as `enabled` flips", () => {
  const onDismiss = vi.fn();
  function Toggling() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button type="button" onClick={() => setOpen((o) => !o)}>toggle</button>
        <Host onDismiss={onDismiss} enabled={open} />
      </>
    );
  }
  render(<Toggling />);
  fireEvent.keyDown(document, { key: "Escape" });
  expect(onDismiss).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: "toggle" }));
  fireEvent.keyDown(document, { key: "Escape" });
  expect(onDismiss).toHaveBeenCalledTimes(1);

  fireEvent.click(screen.getByRole("button", { name: "toggle" }));
  fireEvent.keyDown(document, { key: "Escape" });
  expect(onDismiss).toHaveBeenCalledTimes(1);
});

it("removes its document listeners on unmount", () => {
  const onDismiss = vi.fn();
  const view = render(<Host onDismiss={onDismiss} />);
  view.unmount();
  fireEvent.mouseDown(document.body);
  fireEvent.keyDown(document, { key: "Escape" });
  expect(onDismiss).not.toHaveBeenCalled();
});

it("dismisses on an outside mousedown while the ref is still null", () => {
  // A component may call the hook before its element mounts (or after it
  // conditionally renders nothing); a null ref must read as "everything is
  // outside", never crash.
  const onDismiss = vi.fn();
  function Unattached() {
    const ref = useRef<HTMLDivElement | null>(null);
    useDismiss(ref, onDismiss);
    return null;
  }
  render(<Unattached />);
  fireEvent.mouseDown(document.body);
  expect(onDismiss).toHaveBeenCalledTimes(1);
});
