import { expect, it, vi } from "vitest";
import type { BacklinkBatchPayload, BacklinkBatchState } from "./backlinkBatchWalk";
import { mergeBacklinkResult, walkBacklinkBatches } from "./backlinkBatchWalk";

function batch(over: Partial<BacklinkBatchPayload["backlinks"]> = {},
               refTexts: BacklinkBatchPayload["block_ref_texts"] = {}): BacklinkBatchPayload {
  return {
    backlinks: { groups: [], total_pages: 1, ...over },
    block_ref_texts: refTexts,
  };
}

// totalPages unknown until the first batch reports it -- a sentinel that's
// always "more remaining" so the walk fetches at least once, same trick
// BacklinksSection's refresh uses for a from-scratch walk.
const unknown: BacklinkBatchState = { groups: [], totalPages: Infinity, refTexts: {} };

it("walks multiple batches, growing groups and total pages as it goes", async () => {
  const fetchBatch = vi.fn()
    .mockResolvedValueOnce(batch({
      groups: [{ page_id: 1, page_title: "A", items: [{ uid: "u1", text: "one", breadcrumbs: [] }] }],
      total_pages: 3,
    }))
    .mockResolvedValueOnce(batch({
      groups: [{ page_id: 2, page_title: "B", items: [{ uid: "u2", text: "two", breadcrumbs: [] }] }],
      total_pages: 3,
    }))
    .mockResolvedValueOnce(batch({
      groups: [{ page_id: 3, page_title: "C", items: [{ uid: "u3", text: "three", breadcrumbs: [] }] }],
      total_pages: 3,
    }));

  const result = await walkBacklinkBatches(
    fetchBatch, unknown,
    (state) => (state.groups.length < state.totalPages ? 1 : null),
    () => false,
  );

  expect(result).toEqual({
    groups: [
      { page_id: 1, page_title: "A", items: [{ uid: "u1", text: "one", breadcrumbs: [] }] },
      { page_id: 2, page_title: "B", items: [{ uid: "u2", text: "two", breadcrumbs: [] }] },
      { page_id: 3, page_title: "C", items: [{ uid: "u3", text: "three", breadcrumbs: [] }] },
    ],
    totalPages: 3,
    refTexts: {},
  });
  expect(fetchBatch).toHaveBeenNthCalledWith(1, 0, 1);
  expect(fetchBatch).toHaveBeenNthCalledWith(2, 1, 1);
  expect(fetchBatch).toHaveBeenNthCalledWith(3, 2, 1);
});

it("dedupes items a later batch repeats for an already-seen page", async () => {
  const fetchBatch = vi.fn()
    .mockResolvedValueOnce(batch({
      groups: [{ page_id: 9, page_title: "Src", items: [{ uid: "s1", text: "one", breadcrumbs: [] }] }],
      total_pages: 2,
    }))
    .mockResolvedValueOnce(batch({
      // same page, one repeated item + one new item
      groups: [{ page_id: 9, page_title: "Src",
                 items: [{ uid: "s1", text: "one", breadcrumbs: [] }, { uid: "s2", text: "two", breadcrumbs: [] }] }],
      total_pages: 2,
    }));

  const result = await walkBacklinkBatches(
    fetchBatch, unknown,
    (state) => (state.groups.length < state.totalPages ? 1 : null),
    () => false,
  );

  expect(result).not.toBe("stale");
  expect((result as BacklinkBatchState).groups).toEqual([
    { page_id: 9, page_title: "Src", items: [{ uid: "s1", text: "one", breadcrumbs: [] }, { uid: "s2", text: "two", breadcrumbs: [] }] },
  ]);
});

it("stops without applying a batch once the caller reports staleness", async () => {
  let calls = 0;
  const fetchBatch = vi.fn(async () => {
    calls += 1;
    return batch({
      groups: [{ page_id: calls, page_title: `P${calls}`, items: [{ uid: `u${calls}`, text: "x", breadcrumbs: [] }] }],
      total_pages: 3,
    });
  });
  // stale as soon as the second fetch resolves
  const isStale = () => calls >= 2;

  const result = await walkBacklinkBatches(
    fetchBatch, unknown,
    (state) => (state.groups.length < state.totalPages ? 1 : null),
    isStale,
  );

  expect(result).toBe("stale");
  expect(fetchBatch).toHaveBeenCalledTimes(2);
});

it("propagates a batch fetch failure without applying any partial progress", async () => {
  const fetchBatch = vi.fn()
    .mockResolvedValueOnce(batch({
      groups: [{ page_id: 1, page_title: "A", items: [{ uid: "u1", text: "one", breadcrumbs: [] }] }],
      total_pages: 3,
    }))
    .mockRejectedValueOnce(new Error("network down"));

  await expect(walkBacklinkBatches(
    fetchBatch, unknown,
    (state) => (state.groups.length < state.totalPages ? 1 : null),
    () => false,
  )).rejects.toThrow("network down");
});

it("stops on an empty batch even though the reported total says there's more", async () => {
  const fetchBatch = vi.fn().mockResolvedValueOnce(batch({ groups: [], total_pages: 5 }));

  const result = await walkBacklinkBatches(
    fetchBatch, unknown,
    (state) => (state.groups.length < state.totalPages ? 1 : null),
    () => false,
  );

  expect(result).toEqual({ groups: [], totalPages: 5, refTexts: {} });
  expect(fetchBatch).toHaveBeenCalledTimes(1);
});

it("stops when a non-empty batch yields no new distinct group (no-growth termination)", async () => {
  const fetchBatch = vi.fn().mockResolvedValueOnce(batch({
    // merges into the page already present in the starting state -- group count doesn't grow
    groups: [{ page_id: 1, page_title: "A", items: [{ uid: "u2", text: "two", breadcrumbs: [] }] }],
    total_pages: 5,
  }));
  const starting: BacklinkBatchState = {
    groups: [{ page_id: 1, page_title: "A", items: [{ uid: "u1", text: "one", breadcrumbs: [] }] }],
    totalPages: 2, // stale total from an earlier response -- looks like there's more
    refTexts: {},
  };

  const result = await walkBacklinkBatches(
    fetchBatch, starting,
    (state) => (state.groups.length < state.totalPages ? 1 : null),
    () => false,
  );

  expect(result).toEqual({
    groups: [{ page_id: 1, page_title: "A",
               items: [{ uid: "u1", text: "one", breadcrumbs: [] }, { uid: "u2", text: "two", breadcrumbs: [] }] }],
    totalPages: 5,
    refTexts: {},
  });
  expect(fetchBatch).toHaveBeenCalledTimes(1);
});

it("merges block_ref_texts across batches", async () => {
  const fetchBatch = vi.fn()
    .mockResolvedValueOnce(batch(
      { groups: [{ page_id: 1, page_title: "A", items: [{ uid: "u1", text: "one", breadcrumbs: [] }] }], total_pages: 2 },
      { r1: { text: "ref one", page_title: "A" } },
    ))
    .mockResolvedValueOnce(batch(
      { groups: [{ page_id: 2, page_title: "B", items: [{ uid: "u2", text: "two", breadcrumbs: [] }] }], total_pages: 2 },
      { r2: { text: "ref two", page_title: "B" } },
    ));

  const result = await walkBacklinkBatches(
    fetchBatch, unknown,
    (state) => (state.groups.length < state.totalPages ? 1 : null),
    () => false,
  );

  expect(result).not.toBe("stale");
  expect((result as BacklinkBatchState).refTexts).toEqual({
    r1: { text: "ref one", page_title: "A" },
    r2: { text: "ref two", page_title: "B" },
  });
});

it("fetches a single batch and stops when nextLimit only allows one (loadMore-style)", async () => {
  const fetchBatch = vi.fn().mockResolvedValueOnce(batch({
    groups: [{ page_id: 4, page_title: "D", items: [{ uid: "u4", text: "four", breadcrumbs: [] }] }],
    total_pages: 9,
  }));
  const starting: BacklinkBatchState = { groups: [], totalPages: 9, refTexts: {} };

  const result = await walkBacklinkBatches(
    fetchBatch, starting,
    (_state, batchesFetched) => (batchesFetched === 0 ? 20 : null),
    () => false,
  );

  expect(result).toEqual({
    groups: [{ page_id: 4, page_title: "D", items: [{ uid: "u4", text: "four", breadcrumbs: [] }] }],
    totalPages: 9,
    refTexts: {},
  });
  expect(fetchBatch).toHaveBeenCalledTimes(1);
  expect(fetchBatch).toHaveBeenCalledWith(0, 20);
});

it("mergeBacklinkResult merges a walk result onto the latest state without dropping either side", () => {
  const current: BacklinkBatchState = {
    groups: [{ page_id: 3, page_title: "C", items: [{ uid: "c1", text: "c", breadcrumbs: [] }] }],
    totalPages: 3,
    refTexts: { rc: { text: "ref c", page_title: "C" } },
  };
  const result: BacklinkBatchState = {
    groups: [
      { page_id: 1, page_title: "A", items: [{ uid: "a1", text: "a", breadcrumbs: [] }] },
      { page_id: 2, page_title: "B", items: [{ uid: "b1", text: "b", breadcrumbs: [] }] },
    ],
    totalPages: 3,
    refTexts: { ra: { text: "ref a", page_title: "A" } },
  };

  expect(mergeBacklinkResult(current, result)).toEqual({
    groups: [
      { page_id: 3, page_title: "C", items: [{ uid: "c1", text: "c", breadcrumbs: [] }] },
      { page_id: 1, page_title: "A", items: [{ uid: "a1", text: "a", breadcrumbs: [] }] },
      { page_id: 2, page_title: "B", items: [{ uid: "b1", text: "b", breadcrumbs: [] }] },
    ],
    totalPages: 3,
    refTexts: {
      rc: { text: "ref c", page_title: "C" },
      ra: { text: "ref a", page_title: "A" },
    },
  });
});

it("mergeBacklinkResult is order-independent for two concurrent results (loadMore/loadAll race)", () => {
  // simulates: loadAll's result committed first, then loadMore's own
  // (independently-fetched, overlapping) result merges on top -- and the
  // reverse order -- converging to the same union either way.
  const initial: BacklinkBatchState = {
    groups: [{ page_id: 1, page_title: "A", items: [{ uid: "a1", text: "a", breadcrumbs: [] }] }],
    totalPages: 3,
    refTexts: {},
  };
  const loadAllResult: BacklinkBatchState = {
    groups: [
      { page_id: 1, page_title: "A", items: [{ uid: "a1", text: "a", breadcrumbs: [] }] },
      { page_id: 2, page_title: "B", items: [{ uid: "b1", text: "b", breadcrumbs: [] }] },
      { page_id: 3, page_title: "C", items: [{ uid: "c1", text: "c", breadcrumbs: [] }] },
    ],
    totalPages: 3,
    refTexts: {},
  };
  const loadMoreResult: BacklinkBatchState = {
    // loadMore started from the stale 1-group snapshot and only fetched one
    // more batch -- it never saw page C.
    groups: [
      { page_id: 1, page_title: "A", items: [{ uid: "a1", text: "a", breadcrumbs: [] }] },
      { page_id: 2, page_title: "B", items: [{ uid: "b1", text: "b", breadcrumbs: [] }] },
    ],
    totalPages: 3,
    refTexts: {},
  };

  const loadAllThenLoadMore =
    mergeBacklinkResult(mergeBacklinkResult(initial, loadAllResult), loadMoreResult);
  const loadMoreThenLoadAll =
    mergeBacklinkResult(mergeBacklinkResult(initial, loadMoreResult), loadAllResult);

  // page C must survive regardless of which settles last.
  expect(loadAllThenLoadMore.groups.map((g) => g.page_id)).toEqual([1, 2, 3]);
  expect(loadMoreThenLoadAll.groups.map((g) => g.page_id)).toEqual([1, 2, 3]);
  expect(loadAllThenLoadMore).toEqual(loadMoreThenLoadAll);
});

it("makes no fetch when nextLimit immediately says to stop", async () => {
  const fetchBatch = vi.fn();
  const alreadyDone: BacklinkBatchState = { groups: [{
    page_id: 1, page_title: "A", items: [{ uid: "u1", text: "one", breadcrumbs: [] }],
  }], totalPages: 1, refTexts: {} };

  const result = await walkBacklinkBatches(
    fetchBatch, alreadyDone,
    (state) => (state.groups.length < state.totalPages ? 100 : null),
    () => false,
  );

  expect(result).toEqual(alreadyDone);
  expect(fetchBatch).not.toHaveBeenCalled();
});
