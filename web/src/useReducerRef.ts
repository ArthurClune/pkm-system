// pattern: Imperative Shell
// A reducer whose shell must read the latest state in the same handler that
// dispatched: a single-flight lock (a second click before React re-renders
// must see the first click's load), or a load id the fetch it starts checks
// when it lands. A plain useReducer's state in a handler is the last
// render's, so neither works there.
//
// The reducer is read once, at mount: pass a module-level function. A
// dispatch whose reducer returns the same object sets no state, so a refused
// or ignored event costs no render.
import { useRef, useState } from "react";

export interface ReducerRef<S, E> {
  /** The rendered state. */
  readonly state: S;
  /** The latest state, including a dispatch not yet rendered. */
  readonly current: () => S;
  /** Applies `event` and returns the next state. */
  readonly dispatch: (event: E) => S;
}

export function useReducerRef<S, E>(
  reducer: (state: S, event: E) => S, init: () => S,
): ReducerRef<S, E> {
  const [state, setState] = useState(init);
  const latest = useRef(state);
  const [api] = useState(() => ({
    current: () => latest.current,
    dispatch: (event: E) => {
      const next = reducer(latest.current, event);
      if (next !== latest.current) {
        latest.current = next;
        setState(() => next);
      }
      return next;
    },
  }));
  return { state, current: api.current, dispatch: api.dispatch };
}
