import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { WriteNotice } from "./WriteNotice";

it("shows the message with Undo and Dismiss", () => {
  const onUndo = vi.fn();
  const onDismiss = vi.fn();
  render(<WriteNotice message="Set Status:: Read on Alpha"
                      onUndo={onUndo} onDismiss={onDismiss} />);
  const notice = screen.getByRole("status");
  expect(notice).toHaveClass("editor-notice");
  expect(notice).toHaveTextContent("Set Status:: Read on Alpha");
  const undo = screen.getByRole("button", { name: "Undo" });
  expect(undo).toHaveClass("btn-secondary", "btn-compact");
  fireEvent.click(undo);
  fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
  expect(onUndo).toHaveBeenCalledTimes(1);
  expect(onDismiss).toHaveBeenCalledTimes(1);
});

it("has no Undo without its handler", () => {
  render(<WriteNotice message="Saved" onDismiss={vi.fn()} />);
  expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
});

it("its clicks do not reach the host block", () => {
  const hostClick = vi.fn();
  render(<div onClick={hostClick}>
    <WriteNotice message="Saved" onUndo={vi.fn()} onDismiss={vi.fn()} />
  </div>);
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
  expect(hostClick).not.toHaveBeenCalled();
});
