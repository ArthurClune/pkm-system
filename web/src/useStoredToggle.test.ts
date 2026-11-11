import { act, renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { BLOCK_STAMPS_STORAGE_KEY, BLOCK_STAMPS_VALUES, SIDEBAR_STORAGE_KEY,
         SIDEBAR_VALUES } from "./prefKeys";
import { useStoredToggle } from "./useStoredToggle";

const VALUES = ["off", "on"] as const;

it("the stored strings are the ones earlier builds wrote", () => {
  expect(SIDEBAR_STORAGE_KEY).toBe("pkm:sidebar");
  expect(SIDEBAR_VALUES).toEqual(["open", "collapsed"]);
  expect(BLOCK_STAMPS_STORAGE_KEY).toBe("pkm:block-stamps");
  expect(BLOCK_STAMPS_VALUES).toEqual(["off", "on"]);
});

it("a stored on-string reads as on", () => {
  localStorage.setItem("k", "on");
  const { result } = renderHook(() => useStoredToggle("k", VALUES, false));
  expect(result.current[0]).toBe(true);
});

it("a stored off-string reads as off over an on fallback", () => {
  localStorage.setItem("k", "off");
  const { result } = renderHook(() => useStoredToggle("k", VALUES, true));
  expect(result.current[0]).toBe(false);
});

it("an unknown stored string falls back", () => {
  localStorage.setItem("k", "sometimes");
  const { result } = renderHook(() => useStoredToggle("k", VALUES, true));
  expect(result.current[0]).toBe(true);
  expect(localStorage.getItem("k")).toBe("on");
});

it("toggle writes the other string", () => {
  const { result } = renderHook(() => useStoredToggle("k", VALUES, false));

  act(() => result.current[1]());
  expect(result.current[0]).toBe(true);
  expect(localStorage.getItem("k")).toBe("on");

  act(() => result.current[1]());
  expect(result.current[0]).toBe(false);
  expect(localStorage.getItem("k")).toBe("off");
});

it("the fallback's string is written on mount", () => {
  renderHook(() => useStoredToggle("k", VALUES, false));
  expect(localStorage.getItem("k")).toBe("off");
});

it("storage that throws on read gives the fallback", () => {
  vi.spyOn(localStorage, "getItem").mockImplementation(() => {
    throw new DOMException("denied", "SecurityError");
  });
  const { result } = renderHook(() => useStoredToggle("k", VALUES, true));
  expect(result.current[0]).toBe(true);
});

it("toggle keeps one identity across re-renders", () => {
  const { result, rerender } = renderHook(
    () => useStoredToggle("k", VALUES, false));
  const toggle = result.current[1];
  act(() => toggle());
  rerender();
  expect(result.current[1]).toBe(toggle);
});

it("a write to another key does not re-render the hook", () => {
  let renders = 0;
  renderHook(() => {
    renders++;
    return useStoredToggle("k", VALUES, false);
  });
  const before = renders;
  act(() => {
    localStorage.setItem("other", "x");
    window.dispatchEvent(new StorageEvent("storage", { key: "other" }));
  });
  expect(renders).toBe(before);
});
