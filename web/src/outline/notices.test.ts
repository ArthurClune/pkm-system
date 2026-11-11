import { describe, expect, it } from "vitest";
import { clearNoticeIf, NO_NOTICES, noticeList, noticeOf,
         withNotice } from "./notices";

describe("withNotice", () => {
  it("returns the same slots when the slot already holds that value", () => {
    expect(withNotice(NO_NOTICES, "edit", null)).toBe(NO_NOTICES);
    const shown = withNotice(NO_NOTICES, "upload", "a.png: 413");
    expect(withNotice(shown, "upload", "a.png: 413")).toBe(shown);
  });

  it("sets one slot and leaves the others", () => {
    const shown = withNotice(NO_NOTICES, "goodlinks", "No URL nearby");
    expect(shown).toEqual({ upload: null, goodlinks: "No URL nearby",
                            edit: null });
    expect(NO_NOTICES.goodlinks).toBeNull();
    expect(withNotice(shown, "goodlinks", null)).toEqual(NO_NOTICES);
  });
});

describe("clearNoticeIf", () => {
  it("clears the slot while it still holds that text", () => {
    const shown = withNotice(NO_NOTICES, "edit", "refused");
    expect(clearNoticeIf(shown, "edit", "refused")).toEqual(NO_NOTICES);
  });

  it("clearNoticeIf leaves a newer notice", () => {
    const newer = withNotice(NO_NOTICES, "edit", "newer");
    expect(clearNoticeIf(newer, "edit", "older")).toBe(newer);
    expect(clearNoticeIf(NO_NOTICES, "edit", "older")).toBe(NO_NOTICES);
  });
});

it("noticeList orders upload, goodlinks, edit and tones upload as error", () => {
  expect(noticeList(NO_NOTICES)).toEqual([]);
  let slots = withNotice(NO_NOTICES, "edit", "e");
  slots = withNotice(slots, "goodlinks", "g");
  slots = withNotice(slots, "upload", "u");
  expect(noticeList(slots)).toEqual([
    { kind: "upload", tone: "error", text: "u" },
    { kind: "goodlinks", tone: "status", text: "g" },
    { kind: "edit", tone: "status", text: "e" },
  ]);
});

it("noticeOf reads a kind or null", () => {
  const list = noticeList(withNotice(NO_NOTICES, "edit", "e"));
  expect(noticeOf(list, "edit")).toBe("e");
  expect(noticeOf(list, "upload")).toBeNull();
});
