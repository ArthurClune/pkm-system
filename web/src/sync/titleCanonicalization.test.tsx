import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import {
  resetPlainSpaceTitleCanonicalization, setPlainSpaceTitleCanonicalization,
  useTitleReader,
} from "./titleCanonicalization";

afterEach(resetPlainSpaceTitleCanonicalization);

it("reads false before any source has reported", () => {
  const { result } = renderHook(() => useTitleReader());
  expect(result.current.plainSpaceActive).toBe(false);
  expect(result.current("ML ")).toBe("ML ");
});

it("the setter flips the reader a mounted hook returns", () => {
  const { result } = renderHook(() => useTitleReader());
  act(() => setPlainSpaceTitleCanonicalization(true));
  expect(result.current.plainSpaceActive).toBe(true);
  expect(result.current(" ML ")).toBe("ML");
  act(() => setPlainSpaceTitleCanonicalization(false));
  expect(result.current(" ML ")).toBe(" ML ");
});

it("keeps one reader per flag value, so it is a stable memo key", () => {
  const { result, rerender } = renderHook(() => useTitleReader());
  const first = result.current;
  rerender();
  expect(result.current).toBe(first);
});
