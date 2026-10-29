import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { canonicalTitleOf } from "../test-helpers";
import { dropDraft, droppedDrafts,
         resetDroppedDrafts } from "../outline/droppedDrafts";
import { DROPPED_PREVIEW_CHARS,
         DroppedDraftNotice } from "./DroppedDraftNotice";

afterEach(() => {
  resetDroppedDrafts();
  vi.unstubAllGlobals();
});

const LONG = "x".repeat(DROPPED_PREVIEW_CHARS) + "[[a#b]] the tail";

function stubClipboard(writeText: (text: string) => Promise<void>) {
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
}

test("a long draft's preview says it is clipped, and Copy copies all of it",
     async () => {
  const writeText = vi.fn(async (_: string) => undefined);
  stubClipboard(writeText);
  render(<DroppedDraftNotice />);
  act(() => dropDraft({ pageTitle: canonicalTitleOf("Page"), text: LONG,
                        notice: "Bad title." }));

  const banner = screen.getByRole("alert");
  expect(banner).toHaveTextContent("Unsaved text on “Page” could not be saved.");
  expect(banner).not.toHaveTextContent("the tail");
  expect(banner).toHaveTextContent(`Showing the first ${DROPPED_PREVIEW_CHARS} `
    + `of ${LONG.length} characters. Copy copies all of them.`);
  await act(async () => { fireEvent.click(screen.getByText("Copy")); });
  expect(writeText).toHaveBeenCalledWith(LONG);
  expect(screen.getByText("Copied")).toBeInTheDocument();
});

test("a short draft shows whole, with no clipping note", () => {
  render(<DroppedDraftNotice />);
  act(() => dropDraft({ pageTitle: canonicalTitleOf("Page"),
                        text: "see [[C#]]", notice: "Bad title." }));
  expect(screen.getByText("see [[C#]]")).toBeInTheDocument();
  expect(screen.queryByText(/Showing the first/)).toBeNull();
});

test("a failed copy shows the full text to select", async () => {
  stubClipboard(async () => { throw new Error("denied"); });
  render(<DroppedDraftNotice />);
  act(() => dropDraft({ pageTitle: canonicalTitleOf("Page"), text: LONG,
                        notice: "Bad title." }));
  await act(async () => { fireEvent.click(screen.getByText("Copy")); });
  expect(screen.getByLabelText("Unsaved text")).toHaveValue(LONG);
});

test("Copy with no Clipboard API shows the full text to select",
     async () => {
  vi.stubGlobal("navigator", { ...navigator, clipboard: undefined });
  render(<DroppedDraftNotice />);
  act(() => dropDraft({ pageTitle: canonicalTitleOf("Page"), text: LONG,
                        notice: "Bad title." }));
  await act(async () => { fireEvent.click(screen.getByText("Copy")); });
  expect(screen.getByLabelText("Unsaved text")).toHaveValue(LONG);
});

test("Dismiss removes the draft", () => {
  render(<DroppedDraftNotice />);
  act(() => dropDraft({ pageTitle: canonicalTitleOf("Page"),
                        text: "see [[C#]]", notice: "Bad title." }));
  fireEvent.click(screen.getByText("Dismiss"));
  expect(droppedDrafts()).toEqual([]);
  expect(screen.queryByRole("alert")).toBeNull();
});
