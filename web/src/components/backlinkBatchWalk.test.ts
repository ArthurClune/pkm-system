import { expect, it, vi } from "vitest";
import type { BacklinkBatchPayload, BacklinkBatchState } from "./backlinkBatchWalk";
import { mergeBacklinkResult, walkBacklinkBatches } from "./backlinkBatchWalk";
import { pageIdOf, canonicalTitleOf, uidOf } from "../test-helpers";

function batch(over: Partial<BacklinkBatchPayload["backlinks"]> = {},
               refTexts: BacklinkBatchPayload["block_ref_texts"] = {}): BacklinkBatchPayload {
  return {
    backlinks: { groups: [], ancestor_texts: {}, total_pages: 1, ...over },
    block_ref_texts: refTexts,
  };
}

// totalPages unknown until the first batch reports it -- a sentinel that's
// always "more remaining" so the walk fetches at least once, same trick
// BacklinksSection's refresh uses for a from-scratch walk.
const unknown: BacklinkBatchState =
  { groups: [], totalPages: Infinity, refTexts: {}, ancestorTexts: {} };

it("keeps every batch's ancestor texts", async () => {
  const item = (n: number) => ({ uid: uidOf(`tuid-u${n}`), text: "t",
                                 ancestor_uids: [uidOf(`tuid-a${n}`)] });
  const fetchBatch = vi.fn()
    .mockResolvedValueOnce(batch({
      groups: [{ page_id: pageIdOf(1), page_title: canonicalTitleOf("A"),
                 items: [item(1)] }],
      ancestor_texts: { "tuid-a1": "first" }, total_pages: 2 }))
    .mockResolvedValueOnce(batch({
      groups: [{ page_id: pageIdOf(2), page_title: canonicalTitleOf("B"),
                 items: [item(2)] }],
      ancestor_texts: { "tuid-a2": "second" }, total_pages: 2 }));
  const result = await walkBacklinkBatches(
    fetchBatch, unknown,
    (state) => (state.groups.length < state.totalPages ? 1 : null),
    () => false);
  expect(result !== "stale" && result.ancestorTexts)
    .toEqual({ "tuid-a1": "first", "tuid-a2": "second" });
  const merged = mergeBacklinkResult(
    { groups: [], totalPages: 2, refTexts: {}, ancestorTexts: { "tuid-a0": "kept" } },
    { groups: [], totalPages: 2, refTexts: {}, ancestorTexts: { "tuid-a3": "added" } });
  expect(merged.ancestorTexts).toEqual({ "tuid-a0": "kept", "tuid-a3": "added" });
});

it("walks multiple batches, growing groups and total pages as it goes", async () => {
  const fetchBatch = vi.fn()
    .mockResolvedValueOnce(batch({
      groups: [
        { page_id: pageIdOf(1), page_title: canonicalTitleOf("A"), items: [{ uid: uidOf("tuid-u1"), text: "one",
          ancestor_uids: [] }] },
      ],
      total_pages: 3,
    }))
    .mockResolvedValueOnce(batch({
      groups: [
        { page_id: pageIdOf(2), page_title: canonicalTitleOf("B"), items: [{ uid: uidOf("tuid-u2"), text: "two",
          ancestor_uids: [] }] },
      ],
      total_pages: 3,
    }))
    .mockResolvedValueOnce(batch({
      groups: [
        { page_id: pageIdOf(3), page_title: canonicalTitleOf("C"), items: [{ uid: uidOf("tuid-u3"), text: "three",
          ancestor_uids: [] }] },
      ],
      total_pages: 3,
    }));

  const result = await walkBacklinkBatches(
    fetchBatch, unknown,
    (state) => (state.groups.length < state.totalPages ? 1 : null),
    () => false,
  );

  expect(result).toEqual({
    groups: [
      { page_id: pageIdOf(1), page_title: "A", items: [{ uid: "tuid-u1", text: "one", ancestor_uids: [] }] },
      { page_id: pageIdOf(2), page_title: "B", items: [{ uid: "tuid-u2", text: "two", ancestor_uids: [] }] },
      { page_id: pageIdOf(3), page_title: "C", items: [{ uid: "tuid-u3", text: "three", ancestor_uids: [] }] },
    ],
    totalPages: 3,
    refTexts: {}, ancestorTexts: {},
  });
  expect(fetchBatch).toHaveBeenNthCalledWith(1, 0, 1);
  expect(fetchBatch).toHaveBeenNthCalledWith(2, 1, 1);
  expect(fetchBatch).toHaveBeenNthCalledWith(3, 2, 1);
});

it("dedupes items a later batch repeats for an already-seen page", async () => {
  const fetchBatch = vi.fn()
    .mockResolvedValueOnce(batch({
      groups: [
        { page_id: pageIdOf(9), page_title: canonicalTitleOf("Src"), items: [{ uid: uidOf("tuid-s1"), text: "one",
          ancestor_uids: [] }] },
      ],
      total_pages: 2,
    }))
    .mockResolvedValueOnce(batch({
      // same page, one repeated item + one new item
      groups: [{ page_id: pageIdOf(9), page_title: canonicalTitleOf("Src"),
                 items: [{ uid: uidOf("tuid-s1"), text: "one", ancestor_uids: [] },
                         { uid: uidOf("tuid-s2"), text: "two", ancestor_uids: [] }] }],
      total_pages: 2,
    }));

  const result = await walkBacklinkBatches(
    fetchBatch, unknown,
    (state) => (state.groups.length < state.totalPages ? 1 : null),
    () => false,
  );

  expect(result).not.toBe("stale");
  if (result === "stale") throw new Error("the walk went stale");
  expect(result.groups).toEqual([
    {
      page_id: pageIdOf(9),
      page_title: "Src",
      items: [{ uid: "tuid-s1", text: "one", ancestor_uids: [] }, { uid: "tuid-s2", text: "two", ancestor_uids: [] }],
    },
  ]);
});

it("stops without applying a batch once the caller reports staleness", async () => {
  let calls = 0;
  const fetchBatch = vi.fn(async () => {
    calls += 1;
    return batch({
      groups: [
        {
          page_id: pageIdOf(calls),
          page_title: canonicalTitleOf(`P${calls}`),
          items: [{ uid: uidOf(`tuid-u${calls}`), text: "x", ancestor_uids: [] }],
        },
      ],
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
      groups: [
        { page_id: pageIdOf(1), page_title: canonicalTitleOf("A"), items: [{ uid: uidOf("tuid-u1"), text: "one",
          ancestor_uids: [] }] },
      ],
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

  expect(result).toEqual({ groups: [], totalPages: 5, refTexts: {}, ancestorTexts: {} });
  expect(fetchBatch).toHaveBeenCalledTimes(1);
});

it("stops when a non-empty batch yields no new distinct group (no-growth termination)", async () => {
  const fetchBatch = vi.fn().mockResolvedValueOnce(batch({
    // merges into the page already present in the starting state -- group count
    // doesn't grow
    groups: [{ page_id: pageIdOf(1), page_title: canonicalTitleOf("A"), items: [{ uid: uidOf("tuid-u2"), text: "two",
      ancestor_uids: [] }] }],
    total_pages: 5,
  }));
  const starting: BacklinkBatchState = {
    groups: [{ page_id: pageIdOf(1), page_title: canonicalTitleOf("A"), items: [{ uid: uidOf("tuid-u1"), text: "one",
      ancestor_uids: [] }] }],
    totalPages: 2, // stale total from an earlier response -- looks like there's more
    refTexts: {}, ancestorTexts: {},
  };

  const result = await walkBacklinkBatches(
    fetchBatch, starting,
    (state) => (state.groups.length < state.totalPages ? 1 : null),
    () => false,
  );

  expect(result).toEqual({
    groups: [{ page_id: pageIdOf(1), page_title: "A",
               items: [{ uid: "tuid-u1", text: "one", ancestor_uids: [] }, { uid: "tuid-u2", text: "two",
                 ancestor_uids: [] }] }],
    totalPages: 5,
    refTexts: {}, ancestorTexts: {},
  });
  expect(fetchBatch).toHaveBeenCalledTimes(1);
});

it("merges block_ref_texts across batches", async () => {
  const fetchBatch = vi.fn()
    .mockResolvedValueOnce(batch(
      {
        groups: [
          { page_id: pageIdOf(1), page_title: canonicalTitleOf("A"), items: [{ uid: uidOf("tuid-u1"), text: "one",
            ancestor_uids: [] }] },
        ],
        total_pages: 2,
      },
      { r1: { text: "ref one", page_title: canonicalTitleOf("A") } },
    ))
    .mockResolvedValueOnce(batch(
      {
        groups: [
          { page_id: pageIdOf(2), page_title: canonicalTitleOf("B"), items: [{ uid: uidOf("tuid-u2"), text: "two",
            ancestor_uids: [] }] },
        ],
        total_pages: 2,
      },
      { r2: { text: "ref two", page_title: canonicalTitleOf("B") } },
    ));

  const result = await walkBacklinkBatches(
    fetchBatch, unknown,
    (state) => (state.groups.length < state.totalPages ? 1 : null),
    () => false,
  );

  expect(result).not.toBe("stale");
  if (result === "stale") throw new Error("the walk went stale");
  expect(result.refTexts).toEqual({
    r1: { text: "ref one", page_title: "A" },
    r2: { text: "ref two", page_title: "B" },
  });
});

it("fetches a single batch and stops when nextLimit only allows one (loadMore-style)", async () => {
  const fetchBatch = vi.fn().mockResolvedValueOnce(batch({
    groups: [
      { page_id: pageIdOf(4), page_title: canonicalTitleOf("D"), items: [{ uid: uidOf("tuid-u4"), text: "four",
        ancestor_uids: [] }] },
    ],
    total_pages: 9,
  }));
  const starting: BacklinkBatchState = { groups: [], totalPages: 9, refTexts: {}, ancestorTexts: {} };

  const result = await walkBacklinkBatches(
    fetchBatch, starting,
    (_state, batchesFetched) => (batchesFetched === 0 ? 20 : null),
    () => false,
  );

  expect(result).toEqual({
    groups: [{ page_id: pageIdOf(4), page_title: "D", items: [{ uid: "tuid-u4", text: "four", ancestor_uids: [] }] }],
    totalPages: 9,
    refTexts: {}, ancestorTexts: {},
  });
  expect(fetchBatch).toHaveBeenCalledTimes(1);
  expect(fetchBatch).toHaveBeenCalledWith(0, 20);
});

it("mergeBacklinkResult merges a walk result onto the latest state without dropping either side", () => {
  const current: BacklinkBatchState = {
    groups: [{ page_id: pageIdOf(3), page_title: canonicalTitleOf("C"), items: [{ uid: uidOf("tuid-c1"), text: "c",
      ancestor_uids: [] }] }],
    totalPages: 3,
    ancestorTexts: {},
    refTexts: { rc: { text: "ref c", page_title: canonicalTitleOf("C") } },
  };
  const result: BacklinkBatchState = {
    groups: [
      { page_id: pageIdOf(1), page_title: canonicalTitleOf("A"), items: [{ uid: uidOf("tuid-a1"), text: "a",
        ancestor_uids: [] }] },
      { page_id: pageIdOf(2), page_title: canonicalTitleOf("B"), items: [{ uid: uidOf("tuid-b1"), text: "b",
        ancestor_uids: [] }] },
    ],
    totalPages: 3,
    ancestorTexts: {},
    refTexts: { ra: { text: "ref a", page_title: canonicalTitleOf("A") } },
  };

  expect(mergeBacklinkResult(current, result)).toEqual({
    groups: [
      { page_id: pageIdOf(3), page_title: "C", items: [{ uid: "tuid-c1", text: "c", ancestor_uids: [] }] },
      { page_id: pageIdOf(1), page_title: "A", items: [{ uid: "tuid-a1", text: "a", ancestor_uids: [] }] },
      { page_id: pageIdOf(2), page_title: "B", items: [{ uid: "tuid-b1", text: "b", ancestor_uids: [] }] },
    ],
    totalPages: 3,
    ancestorTexts: {},
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
    groups: [{ page_id: pageIdOf(1), page_title: canonicalTitleOf("A"), items: [{ uid: uidOf("tuid-a1"), text: "a",
      ancestor_uids: [] }] }],
    totalPages: 3,
    refTexts: {}, ancestorTexts: {},
  };
  const loadAllResult: BacklinkBatchState = {
    groups: [
      { page_id: pageIdOf(1), page_title: canonicalTitleOf("A"), items: [{ uid: uidOf("tuid-a1"), text: "a",
        ancestor_uids: [] }] },
      { page_id: pageIdOf(2), page_title: canonicalTitleOf("B"), items: [{ uid: uidOf("tuid-b1"), text: "b",
        ancestor_uids: [] }] },
      { page_id: pageIdOf(3), page_title: canonicalTitleOf("C"), items: [{ uid: uidOf("tuid-c1"), text: "c",
        ancestor_uids: [] }] },
    ],
    totalPages: 3,
    refTexts: {}, ancestorTexts: {},
  };
  const loadMoreResult: BacklinkBatchState = {
    // loadMore started from the stale 1-group snapshot and only fetched one
    // more batch -- it never saw page C.
    groups: [
      { page_id: pageIdOf(1), page_title: canonicalTitleOf("A"), items: [{ uid: uidOf("tuid-a1"), text: "a",
        ancestor_uids: [] }] },
      { page_id: pageIdOf(2), page_title: canonicalTitleOf("B"), items: [{ uid: uidOf("tuid-b1"), text: "b",
        ancestor_uids: [] }] },
    ],
    totalPages: 3,
    refTexts: {}, ancestorTexts: {},
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
    page_id: pageIdOf(1), page_title: canonicalTitleOf("A"), items: [{ uid: uidOf("tuid-u1"), text: "one",
      ancestor_uids: [] }],
  }], totalPages: 1, refTexts: {}, ancestorTexts: {} };

  const result = await walkBacklinkBatches(
    fetchBatch, alreadyDone,
    (state) => (state.groups.length < state.totalPages ? 100 : null),
    () => false,
  );

  expect(result).toEqual(alreadyDone);
  expect(fetchBatch).not.toHaveBeenCalled();
});
