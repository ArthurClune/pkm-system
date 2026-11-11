import { act, renderHook } from "@testing-library/react";
import { expect, it } from "vitest";
import { useReducerRef } from "./useReducerRef";

interface Counter { readonly n: number }
type CounterEvent = { type: "add"; by: number } | { type: "noop" };

const counter = (state: Counter, event: CounterEvent): Counter =>
  event.type === "add" ? { n: state.n + event.by } : state;
const zero = (): Counter => ({ n: 0 });

function renderCounter() {
  let renders = 0;
  const hook = renderHook(() => {
    renders += 1;
    return useReducerRef(counter, zero);
  });
  return { ...hook, renders: () => renders };
}

it("dispatch returns the next state synchronously", () => {
  const { result } = renderCounter();
  let next: Counter | undefined;
  act(() => { next = result.current.dispatch({ type: "add", by: 2 }); });
  expect(next).toEqual({ n: 2 });
  expect(result.current.state).toBe(next);
});

it("current() sees a dispatch before the re-render", () => {
  const { result } = renderCounter();
  act(() => {
    const { dispatch, current, state } = result.current;
    dispatch({ type: "add", by: 1 });
    expect(current()).toEqual({ n: 1 });
    dispatch({ type: "add", by: 1 });
    expect(current()).toEqual({ n: 2 });
    expect(state).toEqual({ n: 0 });
  });
  expect(result.current.state).toEqual({ n: 2 });
});

it("a reducer that returns the same state causes no render", () => {
  const { result, renders } = renderCounter();
  const before = renders();
  const state = result.current.state;
  act(() => { expect(result.current.dispatch({ type: "noop" })).toBe(state); });
  expect(renders()).toBe(before);
});

it("dispatch and current keep their identity across renders", () => {
  const { result, rerender } = renderCounter();
  const { dispatch, current } = result.current;
  act(() => { dispatch({ type: "add", by: 1 }); });
  rerender();
  expect(result.current.dispatch).toBe(dispatch);
  expect(result.current.current).toBe(current);
});
