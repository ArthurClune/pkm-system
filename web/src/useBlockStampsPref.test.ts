import { act, renderHook } from "@testing-library/react";
import { expect, it } from "vitest";
import { BLOCK_STAMPS_STORAGE_KEY } from "./blockStampsPref";
import { useBlockStampsPref } from "./useBlockStampsPref";

it("defaults to hidden stamps and materialises that default in storage", () => {
  const { result } = renderHook(() => useBlockStampsPref());
  expect(result.current.stamps).toBe(false);
  expect(localStorage.getItem(BLOCK_STAMPS_STORAGE_KEY)).toBe("off");
});

it("toggles the column on and off, persisting each step", () => {
  const { result } = renderHook(() => useBlockStampsPref());

  act(() => result.current.toggle());
  expect(result.current.stamps).toBe(true);
  expect(localStorage.getItem(BLOCK_STAMPS_STORAGE_KEY)).toBe("on");

  act(() => result.current.toggle());
  expect(result.current.stamps).toBe(false);
  expect(localStorage.getItem(BLOCK_STAMPS_STORAGE_KEY)).toBe("off");
});

it("honours a persisted 'on' preference on first render", () => {
  localStorage.setItem(BLOCK_STAMPS_STORAGE_KEY, "on");
  const { result } = renderHook(() => useBlockStampsPref());
  expect(result.current.stamps).toBe(true);
});

it("ignores a stored value the guard rejects", () => {
  localStorage.setItem(BLOCK_STAMPS_STORAGE_KEY, "sometimes");
  const { result } = renderHook(() => useBlockStampsPref());
  expect(result.current.stamps).toBe(false);
});

it("keeps a toggle identity stable across re-renders", () => {
  const { result, rerender } = renderHook(() => useBlockStampsPref());
  const toggle = result.current.toggle;
  rerender();
  expect(result.current.toggle).toBe(toggle);
});
