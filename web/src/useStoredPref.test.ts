import { act, renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { useStoredPref } from "./useStoredPref";

type Colour = "red" | "blue";

const isColour = (value: string | null | undefined): value is Colour =>
  value === "red" || value === "blue";

const KEY = "pkm:test-colour";

it("falls back when nothing is stored, and writes the fallback on mount", () => {
  const { result } = renderHook(() => useStoredPref(KEY, isColour, "red"));
  expect(result.current[0]).toBe("red");
  expect(localStorage.getItem(KEY)).toBe("red");
});

it("reads a previously persisted value", () => {
  localStorage.setItem(KEY, "blue");
  const { result } = renderHook(() => useStoredPref(KEY, isColour, "red"));
  expect(result.current[0]).toBe("blue");
});

it("falls back when the stored value fails the guard", () => {
  localStorage.setItem(KEY, "purple");
  const { result } = renderHook(() => useStoredPref(KEY, isColour, "red"));
  expect(result.current[0]).toBe("red");
});

it("persists every change, including via the updater form", () => {
  const { result } = renderHook(() => useStoredPref(KEY, isColour, "red"));

  act(() => result.current[1]("blue"));
  expect(result.current[0]).toBe("blue");
  expect(localStorage.getItem(KEY)).toBe("blue");

  act(() => result.current[1]((c) => (c === "blue" ? "red" : "blue")));
  expect(result.current[0]).toBe("red");
  expect(localStorage.getItem(KEY)).toBe("red");
});

it("falls back when reading storage throws (private mode / disabled)", () => {
  vi.stubGlobal("localStorage", {
    getItem() { throw new Error("SecurityError"); },
    setItem() { /* writes are exercised separately */ },
  });
  const { result } = renderHook(() => useStoredPref(KEY, isColour, "red"));
  expect(result.current[0]).toBe("red");
  vi.unstubAllGlobals();
});

it("keeps working in memory when writing to storage throws", () => {
  const setItem = vi.fn(() => { throw new Error("QuotaExceededError"); });
  vi.stubGlobal("localStorage", { getItem: () => "blue", setItem });

  const { result } = renderHook(() => useStoredPref(KEY, isColour, "red"));
  expect(result.current[0]).toBe("blue");
  act(() => result.current[1]("red"));
  expect(result.current[0]).toBe("red");
  expect(setItem).toHaveBeenCalled();
  vi.unstubAllGlobals();
});

it("keeps the stored value under StrictMode's double mount", () => {
  localStorage.setItem(KEY, "blue");
  const { result } = renderHook(() => useStoredPref(KEY, isColour, "red"),
    { reactStrictMode: true });
  expect(result.current[0]).toBe("blue");
  expect(localStorage.getItem(KEY)).toBe("blue");
});

it("hands back a setter stable enough to sit in a dependency array", () => {
  const { result, rerender } = renderHook(() => useStoredPref(KEY, isColour, "red"));
  const first = result.current[1];
  rerender();
  expect(result.current[1]).toBe(first);
});
