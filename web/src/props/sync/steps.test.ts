import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { TIMED_OUT } from "./quiesce";
import { waitUntil } from "./steps";

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

test("waitUntil resolves once ready holds", async () => {
  let ready = false;
  const waiting = waitUntil(() => ready, 1_000);
  await vi.advanceTimersByTimeAsync(20);
  ready = true;
  await vi.advanceTimersByTimeAsync(5);
  expect(await waiting).toBeUndefined();
});

test("waitUntil stops polling once it times out", async () => {
  let polls = 0;
  const waiting = waitUntil(() => { polls += 1; return false; }, 50);
  await vi.advanceTimersByTimeAsync(60);
  expect(await waiting).toBe(TIMED_OUT);
  const atTimeout = polls;
  await vi.advanceTimersByTimeAsync(1_000);
  expect(polls).toBe(atTimeout);
  expect(vi.getTimerCount()).toBe(0);
});
