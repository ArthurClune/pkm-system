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

// Same race as BlockInput's (pkm-j7ez): the caret after a pick used to be
// placed in a requestAnimationFrame, so until the next frame it sat at the
// end of the text and typing there was later yanked back. Frames are held
// back here; the caret must be right without one and stay where typing put it.
test("a mid-text completion places the caret after the ref before any frame (pkm-j7ez)", async () => {
  const frames: FrameRequestCallback[] = [];
  const spy = vi.spyOn(window, "requestAnimationFrame")
    .mockImplementation((cb) => { frames.push(cb); return frames.length; });
  try {
    stubFetch([["/api/titles", { titles: ["Alpha", "Alpine"] }]]);
    render(<Composer onSend={vi.fn()} readOnly={false} />);
    const ta = screen.getByRole("textbox", { name: "Add to this page" }) as
      HTMLTextAreaElement;
    fireEvent.change(ta, {
      target: { value: "See [[Al and more", selectionStart: 8, selectionEnd: 8 },
    });
    fireEvent.mouseDown(await screen.findByRole("option", { name: "Alpha" }));
    expect(ta).toHaveValue("See [[Alpha]] and more");
    expect([ta.selectionStart, ta.selectionEnd]).toEqual([13, 13]);
    fireEvent.change(ta, { target: { value: "See [[Alpha]]! and more" } });
    ta.setSelectionRange(14, 14);
    frames.splice(0).forEach((cb) => cb(0));
    expect([ta.selectionStart, ta.selectionEnd]).toEqual([14, 14]);
  } finally {
    spy.mockRestore();
  }
});

// A pick that leaves the text unchanged (re-picking the title already inside
// [[…]]) commits nothing, so no layout effect runs: the caret must move
// past the ref at once, and no offset may be left pending for a later edit.
test("a pick that leaves the text unchanged still places the caret, and leaves nothing pending", async () => {
  stubFetch([["/api/titles", { titles: ["Alpha", "Alpine"] }]]);
  render(<Composer onSend={vi.fn()} readOnly={false} />);
  const ta = screen.getByRole("textbox", { name: "Add to this page" }) as
    HTMLTextAreaElement;
  fireEvent.change(ta, {
    target: { value: "See [[Alpha]] x", selectionStart: 11, selectionEnd: 11 },
  });
  fireEvent.mouseDown(await screen.findByRole("option", { name: "Alpha" }));
  expect(ta).toHaveValue("See [[Alpha]] x");
  expect([ta.selectionStart, ta.selectionEnd]).toEqual([13, 13]);
  fireEvent.change(ta, {
    target: { value: "See [[Alpha]] xy", selectionStart: 16, selectionEnd: 16 },
  });
  expect([ta.selectionStart, ta.selectionEnd]).toEqual([16, 16]);
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

test("modified Arrow/Enter/Tab/Escape do not move, pick, or close the popup", async () => {
  // pkm-clt1: Cmd/Ctrl/Shift/Alt variants must be left alone — Composer has
  // no other keyboard shortcuts, so a modified key should leave the popup,
  // selection, and draft exactly as they were.
  stubFetch([["/api/titles", { titles: ["Alpha", "Alpine"] }]]);
  render(<Composer onSend={vi.fn()} readOnly={false} />);
  const ta = typeRefQuery("Al");
  await screen.findByRole("option", { name: "Alpha" });

  const modifierProps = [
    { metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true },
  ];
  for (const key of ["ArrowUp", "ArrowDown", "Enter", "Tab", "Escape"]) {
    for (const mod of modifierProps) {
      fireEvent.keyDown(ta, { key, ...mod });
    }
  }

  expect(ta).toHaveValue("See [[Al");
  expect(screen.getByRole("option", { name: "Alpha" })).toHaveAttribute("aria-selected", "true");
  expect(screen.getByRole("option", { name: "Alpine" })).toHaveAttribute("aria-selected", "false");
});

test("a selection-only caret move drops the stale completion (pkm-noow)", async () => {
  // Clicking (or arrowing) elsewhere in the textarea moves selectionStart
  // without firing an input event, so the context captured by the last
  // onChange still points at "[[Al". jsdom does not move the caret for a
  // native arrow key, so the move is made the way the browser makes it —
  // by setting the selection before the next keydown is dispatched.
  stubFetch([["/api/titles", { titles: ["Alpha"] }]]);
  const onSend = vi.fn();
  render(<Composer onSend={onSend} readOnly={false} />);
  const ta = typeRefQuery("Al");
  await screen.findByRole("option", { name: "Alpha" });

  ta.setSelectionRange(3, 3); // "See| [[Al"
  // Enter must stay a newline: not swallowed, and nothing spliced.
  expect(fireEvent.keyDown(ta, { key: "Enter" })).toBe(true);
  expect(ta).toHaveValue("See [[Al");
  expect(screen.queryByRole("listbox")).toBeNull();

  // Same for a mouse pick that arrives after the caret has moved: with the
  // popup gone there is no row to click, and the draft is untouched.
  expect(onSend).not.toHaveBeenCalled();
});

test("clicking away from the token closes the popup (pkm-noow)", async () => {
  stubFetch([["/api/titles", { titles: ["Alpha"] }]]);
  render(<Composer onSend={vi.fn()} readOnly={false} />);
  const ta = typeRefQuery("Al");
  await screen.findByRole("option", { name: "Alpha" });

  ta.setSelectionRange(3, 3); // the browser moves the caret, then clicks
  fireEvent.click(ta);
  expect(screen.queryByRole("listbox")).toBeNull();
});

test("a stale completion is not applied by a mouse pick (pkm-noow)", async () => {
  stubFetch([["/api/titles", { titles: ["Alpha"] }]]);
  render(<Composer onSend={vi.fn()} readOnly={false} />);
  const ta = typeRefQuery("Al");
  const option = await screen.findByRole("option", { name: "Alpha" });

  ta.setSelectionRange(3, 3); // caret moved out of the [[ token
  fireEvent.mouseDown(option);
  expect(ta).toHaveValue("See [[Al");
  expect(screen.queryByRole("listbox")).toBeNull();
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
