import { renderHook } from "@testing-library/react";
import { expect, it } from "vitest";
import { useStaleGuard } from "./useStaleGuard";

it("keeps the newest token live and marks every earlier one stale", () => {
  const { result } = renderHook(() => useStaleGuard());
  const first = result.current.begin();
  expect(result.current.isStale(first)).toBe(false);

  const second = result.current.begin();
  expect(result.current.isStale(first)).toBe(true);
  expect(result.current.isStale(second)).toBe(false);
});

it("cancel() invalidates the outstanding token without starting a request", () => {
  const { result } = renderHook(() => useStaleGuard());
  const token = result.current.begin();
  result.current.cancel();
  expect(result.current.isStale(token)).toBe(true);
});

it("hands out a fresh token after a cancel, never the cancelled one", () => {
  const { result } = renderHook(() => useStaleGuard());
  const token = result.current.begin();
  result.current.cancel();
  const next = result.current.begin();
  expect(next).not.toBe(token);
  expect(result.current.isStale(next)).toBe(false);
  expect(result.current.isStale(token)).toBe(true);
});

it("treats a token from before the first begin() as stale", () => {
  const { result } = renderHook(() => useStaleGuard());
  const before = result.current.begin() - 1;
  expect(result.current.isStale(before)).toBe(true);
});

it("survives re-renders with the same identity and the same live token", () => {
  const { result, rerender } = renderHook(() => useStaleGuard());
  const guard = result.current;
  const token = guard.begin();
  rerender();
  expect(result.current).toBe(guard);
  expect(result.current.isStale(token)).toBe(false);
});
