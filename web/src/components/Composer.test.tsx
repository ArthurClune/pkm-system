import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { stubFetch } from "../test-helpers";
import { Composer } from "./Composer";

function typeRefQuery(query: string): HTMLTextAreaElement {
  const ta = screen.getByRole("textbox", { name: "Add to this page" }) as
    HTMLTextAreaElement;
  const value = `See [[${query}`;
  fireEvent.change(ta, {
    target: { value, selectionStart: value.length, selectionEnd: value.length },
  });
  return ta;
}

test("send delivers trimmed text and clears the box", () => {
  const onSend = vi.fn();
  render(<Composer onSend={onSend} readOnly={false} />);
  const ta = screen.getByRole("textbox", { name: "Add to this page" });
  fireEvent.change(ta, { target: { value: "  hello [[World]]  " } });
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  expect(onSend).toHaveBeenCalledWith("hello [[World]]");
  expect((ta as HTMLTextAreaElement).value).toBe("");
});

test("empty text does not send; readOnly disables everything", () => {
  const onSend = vi.fn();
  const { rerender } = render(<Composer onSend={onSend} readOnly={false} />);
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  expect(onSend).not.toHaveBeenCalled();
  rerender(<Composer onSend={onSend} readOnly />);
  expect(screen.getByRole("textbox", { name: "Add to this page" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Add" })).toBeDisabled();
  expect(screen.getByLabelText("Add photo")).toBeDisabled();
});

test("picking a photo uploads it and appends markdown to the draft", async () => {
  const url = `/assets/${"ee".repeat(32)}/cam.jpg`;
  stubFetch([["/api/assets", { sha256: "ee".repeat(32), filename: "cam.jpg",
                               mime: "image/jpeg", size: 3, url }]]);
  render(<Composer onSend={vi.fn()} readOnly={false} />);
  const picker = screen.getByLabelText("Add photo") as HTMLInputElement;
  fireEvent.change(picker, {
    target: { files: [new File(["jpg"], "cam.jpg", { type: "image/jpeg" })] },
  });
  await vi.waitFor(() => {
    expect((screen.getByRole("textbox", { name: "Add to this page" }) as
            HTMLTextAreaElement).value).toBe(`![cam.jpg](${url})`);
  });
});

test("clicking an autocomplete row completes the page reference", async () => {
  stubFetch([["/api/titles", { titles: ["Alpha", "Alpine"] }]]);
  render(<Composer onSend={vi.fn()} readOnly={false} />);
  const ta = typeRefQuery("Al");
  const option = await screen.findByRole("option", { name: "Alpha" });
  fireEvent.mouseDown(option);
  expect(ta).toHaveValue("See [[Alpha]]");
  expect(screen.queryByRole("listbox")).toBeNull();
});

test("arrow keys choose an autocomplete row and Enter applies it", async () => {
  const onSend = vi.fn();
  stubFetch([["/api/titles", { titles: ["Alpha", "Alpine"] }]]);
  render(<Composer onSend={onSend} readOnly={false} />);
  const ta = typeRefQuery("Al");
  await screen.findByRole("option", { name: "Alpha" });
  fireEvent.keyDown(ta, { key: "ArrowDown" });
  fireEvent.keyDown(ta, { key: "ArrowDown" });
  fireEvent.keyDown(ta, { key: "ArrowUp" });
  fireEvent.keyDown(ta, { key: "Enter" });
  expect(ta).toHaveValue("See [[Alpine]]");
  expect(onSend).not.toHaveBeenCalled();
});

test("Tab applies autocomplete and Escape cancels it", async () => {
  const onSend = vi.fn();
  stubFetch([["/api/titles", { titles: ["Alpha"] }]]);
  const { unmount } = render(<Composer onSend={onSend} readOnly={false} />);
  let ta = typeRefQuery("Al");
  await screen.findByRole("option", { name: "Alpha" });
  fireEvent.keyDown(ta, { key: "Tab" });
  expect(ta).toHaveValue("See [[Alpha]]");
  unmount();

  render(<Composer onSend={onSend} readOnly={false} />);
  ta = typeRefQuery("Al");
  await screen.findByRole("option", { name: "Alpha" });
  fireEvent.keyDown(ta, { key: "Escape" });
  expect(screen.queryByRole("listbox")).toBeNull();
  expect(ta).toHaveValue("See [[Al");
  expect(onSend).not.toHaveBeenCalled();
});
