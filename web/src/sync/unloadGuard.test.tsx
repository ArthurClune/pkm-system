// pkm-0htf: the guard must only interrupt unload while ops are stranded in
// the fallback lane, and must detach the moment that count clears (a
// permanently-attached beforeunload listener disables bfcache).
import { render } from "@testing-library/react";
import { expect, test } from "vitest";
import { useUnloadGuard } from "./unloadGuard";

function Harness({ count }: { count: number }) {
  useUnloadGuard(count);
  return null;
}

function dispatchBeforeUnload(): Event {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event;
}

test("a non-zero unsentInMemory count prevents the default beforeunload action", () => {
  render(<Harness count={1} />);
  expect(dispatchBeforeUnload().defaultPrevented).toBe(true);
});

test("a zero unsentInMemory count leaves beforeunload unguarded", () => {
  render(<Harness count={0} />);
  expect(dispatchBeforeUnload().defaultPrevented).toBe(false);
});

test("the listener is removed once the count drops back to zero", () => {
  const { rerender } = render(<Harness count={1} />);
  expect(dispatchBeforeUnload().defaultPrevented).toBe(true);

  rerender(<Harness count={0} />);
  expect(dispatchBeforeUnload().defaultPrevented).toBe(false);
});
