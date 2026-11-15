import { describe, expect, it } from "vitest";
import { decideCellKey, type CellKey, type CellList } from "./cellKeys";

const key = (k: string, mods: Partial<CellKey> = {}): CellKey => ({
  key: k, shiftKey: false, metaKey: false, ctrlKey: false, altKey: false,
  composing: false, ...mods,
});

const values = (rows: number, selected: number): CellList =>
  ({ rows, selected, floor: -1, closable: false });
const titles = (rows: number, selected: number): CellList =>
  ({ rows, selected, floor: 0, closable: true });

describe("decideCellKey", () => {
  it("Enter commits and Shift-Enter is left to the textarea", () => {
    expect(decideCellKey(key("Enter"), null)).toEqual({ kind: "commit" });
    expect(decideCellKey(key("Enter", { shiftKey: true }), null))
      .toEqual({ kind: "none" });
    expect(decideCellKey(key("Enter", { metaKey: true }), null))
      .toEqual({ kind: "none" });
  });

  it("Esc cancels, or closes a title list first", () => {
    expect(decideCellKey(key("Escape"), null)).toEqual({ kind: "cancel" });
    expect(decideCellKey(key("Escape"), values(2, 0)))
      .toEqual({ kind: "cancel" });
    expect(decideCellKey(key("Escape"), titles(2, 0)))
      .toEqual({ kind: "close-list" });
  });

  it("Tab and Shift-Tab move, even with a list open", () => {
    expect(decideCellKey(key("Tab"), titles(2, 0)))
      .toEqual({ kind: "tab", dir: 1 });
    expect(decideCellKey(key("Tab", { shiftKey: true }), null))
      .toEqual({ kind: "tab", dir: -1 });
    expect(decideCellKey(key("Tab", { metaKey: true }), null))
      .toEqual({ kind: "none" });
  });

  it("arrows move the highlight within the list's bounds", () => {
    expect(decideCellKey(key("ArrowDown"), values(2, -1)))
      .toEqual({ kind: "move", selected: 0 });
    expect(decideCellKey(key("ArrowDown"), values(2, 1)))
      .toEqual({ kind: "move", selected: 1 });
    expect(decideCellKey(key("ArrowUp"), values(2, 0)))
      .toEqual({ kind: "move", selected: -1 });
    expect(decideCellKey(key("ArrowUp"), titles(2, 0)))
      .toEqual({ kind: "move", selected: 0 });
    expect(decideCellKey(key("ArrowDown"), null)).toEqual({ kind: "none" });
    expect(decideCellKey(key("ArrowDown"), values(0, -1)))
      .toEqual({ kind: "none" });
    expect(decideCellKey(key("ArrowDown", { shiftKey: true }), values(2, 0)))
      .toEqual({ kind: "none" });
  });

  it("Enter picks only a highlighted row", () => {
    expect(decideCellKey(key("Enter"), values(2, 1)))
      .toEqual({ kind: "pick" });
    expect(decideCellKey(key("Enter"), values(2, -1)))
      .toEqual({ kind: "commit" });
  });

  it("an IME composition owns every key", () => {
    expect(decideCellKey(key("Enter", { composing: true }), null))
      .toEqual({ kind: "none" });
  });

  it("other keys are the textarea's", () => {
    expect(decideCellKey(key("a"), values(2, 0))).toEqual({ kind: "none" });
  });
});
