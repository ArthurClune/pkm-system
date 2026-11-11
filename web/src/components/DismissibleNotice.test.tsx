import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { DismissibleNotice } from "./DismissibleNotice";

it("an error notice is an alert and a status notice is a status", () => {
  const { container } = render(<>
    <DismissibleNotice tone="error" onDismiss={() => {}}>
      bad.png: 413
    </DismissibleNotice>
    <DismissibleNotice tone="status" onDismiss={() => {}}>
      No URL nearby
    </DismissibleNotice>
  </>);

  expect(container.innerHTML).toBe(
    '<p class="error upload-error" role="alert">bad.png: 413'
    + '<button type="button" class="btn-secondary btn-compact">Dismiss</button></p>'
    + '<p class="editor-notice" role="status">No URL nearby'
    + '<button type="button" class="btn-secondary btn-compact">Dismiss</button></p>');
});

it("Dismiss calls onDismiss", () => {
  const onDismiss = vi.fn();
  render(<DismissibleNotice tone="status" onDismiss={onDismiss}>
    Saved to Goodlinks
  </DismissibleNotice>);

  fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));

  expect(onDismiss).toHaveBeenCalledTimes(1);
});

it("className joins the tone's classes", () => {
  render(<DismissibleNotice tone="error" className="top-bar-error"
                            onDismiss={() => {}}>
    Couldn't export
  </DismissibleNotice>);

  expect(screen.getByRole("alert").className)
    .toBe("error upload-error top-bar-error");
});

it("the Dismiss button is compact", () => {
  render(<DismissibleNotice tone="status" onDismiss={() => {}}>
    Saved
  </DismissibleNotice>);

  expect(screen.getByRole("button", { name: "Dismiss" }))
    .toHaveClass("btn-secondary", "btn-compact");
});
