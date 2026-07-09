import { expect, test } from "vitest";
import { isOutlineActive, registerOutline } from "./activeOutlines";

test("a title is inactive until registered", () => {
  expect(isOutlineActive("Fresh Page")).toBe(false);
});

test("registering marks a title active until the returned cleanup runs", () => {
  const unregister = registerOutline("Some Page");
  expect(isOutlineActive("Some Page")).toBe(true);
  unregister();
  expect(isOutlineActive("Some Page")).toBe(false);
});

test("a second concurrent registration keeps the title active until both unregister", () => {
  const unregisterFirst = registerOutline("Shared Page");
  const unregisterSecond = registerOutline("Shared Page");
  unregisterFirst();
  expect(isOutlineActive("Shared Page")).toBe(true); // second registrant still holds it
  unregisterSecond();
  expect(isOutlineActive("Shared Page")).toBe(false);
});

test("titles are tracked independently", () => {
  const unregister = registerOutline("Page A");
  expect(isOutlineActive("Page A")).toBe(true);
  expect(isOutlineActive("Page B")).toBe(false);
  unregister();
});
