// pattern: Functional Core
// Shared bounded-cache shape for expensive-to-compute rendered output
// (mermaid SVG, KaTeX HTML): a single string-keyed Map, cleared in full once
// it reaches `limit` rather than evicted LRU-style. An LRU only earns its
// complexity when eviction order matters, and it doesn't here -- once the
// live working set of distinct keys exceeds the bound we'd be thrashing
// either way, so a full reset is the simplest thing that bounds memory. Same
// shape (and same tradeoff) as grammar/tokenize.ts's tokenizeCache and
// CodeBlock.tsx's highlightCache, which predate this module and keep their
// own copies rather than being migrated onto it -- this factory is for new
// callers (MermaidDiagram.tsx, MathSpan.tsx) that want the shape without
// duplicating it a third and fourth time.
export interface BoundedCache<V> {
  get(key: string): V | undefined;
  set(key: string, value: V): void;
  size(): number;
  clear(): void;
}

export function createBoundedCache<V>(limit: number): BoundedCache<V> {
  let map = new Map<string, V>();
  return {
    get(key) {
      return map.get(key);
    },
    set(key, value) {
      if (map.size >= limit) map.clear();
      map.set(key, value);
    },
    size() {
      return map.size;
    },
    clear() {
      map.clear();
    },
  };
}
