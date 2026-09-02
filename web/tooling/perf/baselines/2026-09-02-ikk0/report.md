# Outline drag: dragover throttle + row-rect cache (pkm-ikk0)

Scenario K, headless, 300-block "Perf Big Page", 120 synthetic dragovers per
sweep. `before.json` is `worktree-perf-ikk0` at the scenario-K commit (the
handler unchanged); `after.json` is the same build with the throttle and the
rect cache in `src/dnd/useDropZone.ts`.

Three sweeps, because a single number hides the shape of the cost. `boundaryAt`
walked rows only until one's midpoint was below the pointer, so a drag near the
top of the outline was already cheap; the O(rows) walk the bean describes only
bites near the bottom of a long page. K3 repeats K2 at ~250 Hz because at 60 Hz
there is roughly one frame per dragover and nothing for rAF to coalesce.

## dragover handler, ms per event

| sweep | before mean | after mean | before p95 | after p95 | before total | after total |
|---|---|---|---|---|---|---|
| K page top, 60 Hz | 0.172 | **0.073** | 0.4 | 0.2 | 20.6 ms | **8.8 ms** |
| K2 page bottom, 60 Hz | 4.368 | **0.113** | 7.2 | 0.2 | 524.2 ms | **13.6 ms** |
| K3 page bottom, 250 Hz | 3.158 | **0.093** | 4.2 | 0.1 | 379.0 ms | **11.2 ms** |

The everyday case is ~2.4x cheaper; the bottom-of-a-long-page case is ~39x
cheaper, and its whole-drag handler budget falls from half a second to 14 ms.

`max` moves the other way on purpose: 8 ms -> 5.6 ms overall, but the after-run's
maximum is now the *first* dragover of the drag, which walks to row ~300 with a
cold cache. One ~6 ms hitch as the drag begins replaces 4 ms on every event.

## React commits and forced layouts

| sweep | commits/event before | after | fibers/event before | after | commits/s before | after |
|---|---|---|---|---|---|---|
| K top, 60 Hz | 1.02 | 1.01 | 32.1 | 32.1 | 32.1 | 31.8 |
| K2 bottom, 60 Hz | 1.02 | 1.02 | 32.1 | 32.1 | 28.4 | 32.1 |
| K3 bottom, 250 Hz | 1.02 | **0.42** | 32.1 | 29.7 | 46.9 | **22.7** |

At a 60 Hz event rate there is one frame per event, so coalescing has nothing to
collapse and the commit count is unchanged -- as expected. At 250 Hz (a trackpad
flick, which is where dragover outruns frames) commits per event fall 2.4x and
commits per second fall from 46.9 to 22.7.

Forced layouts per event are ~0.08 in both runs. The pre-fix handler's
`getBoundingClientRect` calls were mostly *not* forcing a fresh layout -- nothing
between dragovers dirtied it -- so its 4.4 ms was rect-read plus 300
`querySelector` calls per event, not 300 layouts. That is why the fix is worth
39x rather than the 100x a forced-layout story would predict.

Script time over the whole K2 window: 0.55 s -> 0.07 s.

## Indicator: left in React state, deliberately

Task 6 memoised `EditableBlock`, so a `setIndicator` commit no longer touches
the rows -- only `EditablePage`, the tree container and the indicator div, ~32
fibers. After the cache, K2's entire script budget is 0.07 s over 3.8 s, of
which the handler is 13.6 ms; that leaves ~0.4 ms per commit, one commit per
frame. Moving the indicator to a ref and a direct `style.top` write would save
that 0.4 ms per frame in exchange for ref plumbing and a second source of truth
for where the line is. Not worth it at these numbers -- revisit only if a future
change puts the tree's render back in the per-frame path.

## Observed, not fixed

`maxInOneCommit` is 1687 fibers in both runs: the commit at `dragstart`
re-renders every row on the page. `DndProvider`'s context value is memoised on
`drag`, so starting a drag gives `EditablePage` a new `dnd`, which gives
`onDragStartBlock` a new identity, which gives every row a new `handlers`
object and defeats `EditableBlock`'s memo. It costs once per drag rather than
once per event, so it is not what this bean is about -- but it is the same shape
of problem as pkm-qfee and would be the next thing to look at if drag start
ever feels heavy.

## Not covered by these numbers

The drag is synthetic (page-dispatched `DragEvent`s), so this says nothing
about a real drag's frame rate, and nothing at all about touch DnD. Both the
throttle's rAF path and the scroll-invalidation path need a physical iPad: the
simulator cannot drive post-lift drag moves.
