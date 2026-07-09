import { expect, test } from "vitest";
import { toggleTodo } from "./todo";

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
