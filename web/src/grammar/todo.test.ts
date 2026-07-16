import { expect, test } from "vitest";
import { cycleTodo, hasTodoMarker, toggleTodo } from "./todo";

test("flips TODO to DONE and back, preserving the bracket variant", () => {
  expect(toggleTodo("{{[[TODO]]}} buy milk")).toBe("{{[[DONE]]}} buy milk");
  expect(toggleTodo("{{[[DONE]]}} buy milk")).toBe("{{[[TODO]]}} buy milk");
  expect(toggleTodo("{{TODO}} short form")).toBe("{{DONE}} short form");
});

test("mixed-bracket leniencies are echoed back as-is", () => {
  // The tokenizer accepts these independently (documented plan-4 leniency);
  // Roam never emits them, but a toggle must not corrupt them.
  expect(toggleTodo("{{[[TODO}} x")).toBe("{{[[DONE}} x");
  expect(toggleTodo("{{TODO]]}} x")).toBe("{{DONE]]}} x");
});

test("returns null when the block has no leading marker", () => {
  expect(toggleTodo("no marker {{[[TODO]]}} not at start")).toBeNull();
  expect(toggleTodo("plain")).toBeNull();
});

test("flips a leading marker inside an exact-prefix quote", () => {
  expect(toggleTodo("> {{[[TODO]]}} quoted task"))
    .toBe("> {{[[DONE]]}} quoted task");
  expect(toggleTodo("> {{DONE}} quoted task"))
    .toBe("> {{TODO}} quoted task");
});

test("double toggle is byte-identical for every spelling and quote prefix", () => {
  const spellings = [
    "{{TODO}} x", "{{DONE}} x",
    "{{[[TODO]]}} x", "{{[[DONE]]}} x",
    "{{[[TODO}} x", "{{TODO]]}} x",
    "{{TODO}}", "{{TODO}}  two spaces",
  ];
  for (const text of spellings) {
    expect(toggleTodo(toggleTodo(text)!)).toBe(text);
    expect(toggleTodo(toggleTodo("> " + text)!)).toBe("> " + text);
  }
});

test("hasTodoMarker detects only a block-start marker (no quote prefix)", () => {
  expect(hasTodoMarker("{{TODO}} x")).toBe(true);
  expect(hasTodoMarker("{{[[DONE]]}}")).toBe(true);
  expect(hasTodoMarker("> {{TODO}} x")).toBe(false);
  expect(hasTodoMarker(" {{TODO}} x")).toBe(false);
  expect(hasTodoMarker("plain")).toBe(false);
});

test("code at the start of a block is never a marker", () => {
  expect(toggleTodo("`{{TODO}}` x")).toBeNull();
  expect(hasTodoMarker("`{{TODO}}` x")).toBe(false);
});

test("cycleTodo cycles plain -> TODO -> DONE -> plain", () => {
  expect(cycleTodo("buy milk")).toBe("{{TODO}} buy milk");
  expect(cycleTodo("{{TODO}} buy milk")).toBe("{{DONE}} buy milk");
  expect(cycleTodo("{{DONE}} buy milk")).toBe("buy milk");
});

test("cycleTodo preserves an exact quote prefix at every step", () => {
  expect(cycleTodo("> quoted task")).toBe("> {{TODO}} quoted task");
  expect(cycleTodo("> {{TODO}} quoted task")).toBe("> {{DONE}} quoted task");
  expect(cycleTodo("> {{DONE}} quoted task")).toBe("> quoted task");
});

test("cycleTodo preserves the bracket variant from plain to TODO to DONE", () => {
  expect(cycleTodo("{{[[TODO]]}} buy milk")).toBe("{{[[DONE]]}} buy milk");
});

test("cycleTodo strips a bracket-variant DONE marker back to plain", () => {
  expect(cycleTodo("{{[[DONE]]}} buy milk")).toBe("buy milk");
});

test("cycleTodo on an empty string produces a bare TODO marker", () => {
  expect(cycleTodo("")).toBe("{{TODO}} ");
});
