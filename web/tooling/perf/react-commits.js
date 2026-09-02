// addInitScript payload for scenario J: a minimal React DevTools hook that
// counts React commits and, per commit, how many fibers actually re-rendered.
//
// React calls `hook.onCommitFiberRoot` after every commit when the global is
// present at module-evaluation time, which is why this must be installed
// before the app's bundle runs. Counting re-rendered fibers rather than DOM
// mutations is the point: React reconciles an unchanged render to no DOM
// writes, so a wasted re-render of 30 mounted outlines is invisible to a
// MutationObserver but not to this.
//
// Two React internals make the count sound, and getting either wrong silently
// inflates it by an order of magnitude:
//
//   - `flags & PerformedWork` (1) marks a fiber whose component actually ran
//     ("React DevTools reads this flag" — beginWork). It is only cleared when
//     React clones a fiber for a new render pass, so it is trustworthy on
//     freshly cloned fibers and STALE on reused ones.
//   - A fiber that bailed out with no work anywhere beneath it keeps its
//     previous child list (`f.child === f.alternate.child`); anything React
//     re-entered has a cloned child list instead. So pruning the walk there
//     both skips the untouched subtree and guarantees every fiber visited is
//     a fresh clone whose flag means this commit.
//
// `visited` is therefore itself a churn metric: an untouched subtree costs
// one visit, not its size.
//
// Installed only when J is among the requested scenarios (perf.mjs): walking
// the fiber tree on every commit is real CPU, and would pollute the CPU
// figures of the idle and typing scenarios.
(() => {
  const w = window;
  const R = { commits: 0, rendered: 0, visited: 0, maxRendered: 0 };
  w.__react = R;
  w.__reactReset = () => {
    R.commits = 0; R.rendered = 0; R.visited = 0; R.maxRendered = 0;
  };
  // A real DevTools extension owns the global where one is installed; never
  // replace it, or the numbers become its numbers.
  if (w.__REACT_DEVTOOLS_GLOBAL_HOOK__) return;

  const walk = (root) => {
    let visited = 0;
    let rendered = 0;
    const stack = root ? [root] : [];
    while (stack.length > 0) {
      const fiber = stack.pop();
      visited += 1;
      if ((fiber.flags & 1) !== 0) rendered += 1;
      const prev = fiber.alternate;
      if (prev !== null && fiber.child === prev.child) continue; // reused
      for (let c = fiber.child; c !== null; c = c.sibling) stack.push(c);
    }
    return { visited, rendered };
  };

  // Every method React reaches for. It guards each call with a typeof check
  // and a try/catch, so a missing one is silent — which would silently zero
  // the measurement, hence the explicit no-ops.
  w.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    isDisabled: false,
    renderers: new Map(),
    inject: () => 1,
    checkDCE: () => undefined,
    onScheduleFiberRoot: () => undefined,
    onPostCommitFiberRoot: () => undefined,
    onCommitFiberUnmount: () => undefined,
    onCommitFiberRoot: (_id, root) => {
      R.commits += 1;
      const counted = walk(root.current);
      R.visited += counted.visited;
      R.rendered += counted.rendered;
      if (counted.rendered > R.maxRendered) R.maxRendered = counted.rendered;
    },
  };
})();
