import { describe, expect, it } from "vitest";
import {
  type CellRef, type EditorState, neighbourCell, stepEditor,
} from "./cellEditor";

const A: CellRef = { row: "r1", col: "Author" };
const B: CellRef = { row: "r1", col: "Format" };
const C: CellRef = { row: "r2", col: "Author" };

const IDLE: EditorState = { kind: "idle" };
const editing = (cell: CellRef, original: string, draft = original): EditorState =>
  ({ kind: "editing", cell, original, draft });

describe("stepEditor while idle", () => {
  it("open starts editing with the value as original and draft", () => {
    expect(stepEditor(IDLE, { kind: "open", cell: A, value: "Hohpe" }))
      .toEqual({ state: editing(A, "Hohpe"), effects: [] });
  });

  it.each([
    { kind: "input", draft: "x" },
    { kind: "commit" },
    { kind: "cancel" },
    { kind: "outside" },
    { kind: "tab", dir: 1, next: { cell: B, value: "v" } },
    { kind: "tab", dir: -1, next: null },
  ] as const)("$kind does nothing", (event) => {
    expect(stepEditor(IDLE, event)).toEqual({ state: IDLE, effects: [] });
  });
});

describe("stepEditor while editing", () => {
  const changed = editing(A, "old", "  new\nline  ");
  const write = { kind: "write", cell: A, value: "new\nline" } as const;

  it("input replaces the draft", () => {
    expect(stepEditor(editing(A, "old"), { kind: "input", draft: "x" }))
      .toEqual({ state: editing(A, "old", "x"), effects: [] });
  });

  it.each(["commit", "outside"] as const)(
    "%s writes the trimmed draft and ends idle", (kind) => {
      expect(stepEditor(changed, { kind })).toEqual({ state: IDLE, effects: [write] });
    });

  it.each(["commit", "outside"] as const)(
    "%s with a draft unchanged but for padding writes nothing", (kind) => {
      expect(stepEditor(editing(A, " old", "old  "), { kind }))
        .toEqual({ state: IDLE, effects: [] });
    });

  it("cancel never writes", () => {
    expect(stepEditor(changed, { kind: "cancel" })).toEqual({ state: IDLE, effects: [] });
  });

  it("tab writes, then opens the next cell", () => {
    expect(stepEditor(changed, { kind: "tab", dir: 1, next: { cell: B, value: "b" } }))
      .toEqual({ state: editing(B, "b"), effects: [write] });
  });

  it("tab with an unchanged draft opens the next cell without a write", () => {
    expect(stepEditor(editing(A, "a"), { kind: "tab", dir: -1, next: { cell: B, value: "b" } }))
      .toEqual({ state: editing(B, "b"), effects: [] });
  });

  it("tab with no next cell writes and ends idle", () => {
    expect(stepEditor(changed, { kind: "tab", dir: 1, next: null }))
      .toEqual({ state: IDLE, effects: [write] });
  });

  it("open on another cell commits the old one first", () => {
    expect(stepEditor(changed, { kind: "open", cell: C, value: "c" }))
      .toEqual({ state: editing(C, "c"), effects: [write] });
  });

  it("open on another cell with an unchanged draft writes nothing", () => {
    expect(stepEditor(editing(A, "a"), { kind: "open", cell: C, value: "c" }))
      .toEqual({ state: editing(C, "c"), effects: [] });
  });

  it("open on the same cell keeps the draft", () => {
    expect(stepEditor(changed, { kind: "open", cell: { ...A }, value: "other" }))
      .toEqual({ state: changed, effects: [] });
  });
});

describe("neighbourCell", () => {
  const order = [A, B, C];

  it("steps along the row-major order, across rows", () => {
    expect(neighbourCell(order, A, 1)).toEqual(B);
    expect(neighbourCell(order, B, 1)).toEqual(C);
    expect(neighbourCell(order, C, -1)).toEqual(B);
  });

  it("is null past either end", () => {
    expect(neighbourCell(order, C, 1)).toBeNull();
    expect(neighbourCell(order, A, -1)).toBeNull();
  });

  it("finds the cell by value, and is null for one not in the order", () => {
    expect(neighbourCell(order, { row: "r1", col: "Format" }, 1)).toEqual(C);
    expect(neighbourCell(order, { row: "r9", col: "Author" }, 1)).toBeNull();
  });
});
