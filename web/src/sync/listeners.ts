// pattern: Imperative Shell
// A set of subscribers. A listener that throws never stops the others from
// hearing the same value, nor reaches the code that emitted it.

export type Listener<T> = (value: T) => void;

export function listeners<T>(): {
  add(fn: Listener<T>): () => void;
  emit(value: T): void;
} {
  const set = new Set<Listener<T>>();
  return {
    add(fn: Listener<T>): () => void {
      set.add(fn);
      return () => { set.delete(fn); };
    },
    emit(value: T): void {
      set.forEach((fn) => {
        try { fn(value); } catch { /* listener isolation */ }
      });
    },
  };
}
