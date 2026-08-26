import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { stubMatchMedia } from "./test-helpers";
import { useEffectiveTheme } from "./useEffectiveTheme";

afterEach(() => {
  document.documentElement.removeAttribute("data-theme");
});

it("resolves an explicit data-theme attribute", () => {
  document.documentElement.setAttribute("data-theme", "dark");
  expect(renderHook(() => useEffectiveTheme()).result.current).toBe("dark");
  document.documentElement.setAttribute("data-theme", "light");
  expect(renderHook(() => useEffectiveTheme()).result.current).toBe("light");
});

it("falls back to the OS preference for system (or absent) data-theme", () => {
  const mql = stubMatchMedia(true);
  document.documentElement.setAttribute("data-theme", "system");
  expect(renderHook(() => useEffectiveTheme()).result.current).toBe("dark");
  mql.matches = false;
  document.documentElement.removeAttribute("data-theme");
  expect(renderHook(() => useEffectiveTheme()).result.current).toBe("light");
});

it("tracks a data-theme change made after mount", async () => {
  document.documentElement.setAttribute("data-theme", "light");
  const { result } = renderHook(() => useEffectiveTheme());
  expect(result.current).toBe("light");
  document.documentElement.setAttribute("data-theme", "dark");
  await waitFor(() => expect(result.current).toBe("dark"));
});

it("tracks an OS preference change while on system", async () => {
  const mql = stubMatchMedia(false);
  document.documentElement.setAttribute("data-theme", "system");
  const { result } = renderHook(() => useEffectiveTheme());
  expect(result.current).toBe("light");
  mql.simulateChange(true);
  await waitFor(() => expect(result.current).toBe("dark"));
});
