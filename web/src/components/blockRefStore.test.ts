import { describe, expect, test, vi } from "vitest";
import { createBlockRefStore } from "./blockRefStore";

const text = (t: string) => ({ text: t, page_title: "P" });

describe("createBlockRefStore", () => {
  test("returns undefined for a uid nobody has resolved", () => {
    expect(createBlockRefStore().get("ref_aa1")).toBeUndefined();
  });

  test("serves a resolved entry, by stable identity", () => {
    const store = createBlockRefStore();
    store.resolve({ ref_aa1: text("alpha") });
    expect(store.get("ref_aa1")).toEqual(text("alpha"));
    // getSnapshot is called on every render: an unchanged entry must come
    // back as the same object or useSyncExternalStore re-renders forever.
    expect(store.get("ref_aa1")).toBe(store.get("ref_aa1"));
  });

  test("notifies only the subscribers of the uids a batch resolved", () => {
    const store = createBlockRefStore();
    const onAa1 = vi.fn();
    const onBb2 = vi.fn();
    store.subscribe("ref_aa1", onAa1);
    store.subscribe("ref_bb2", onBb2);

    store.resolve({ ref_aa1: text("alpha") });

    expect(onAa1).toHaveBeenCalledTimes(1);
    expect(onBb2).not.toHaveBeenCalled();
  });

  test("notifies every subscriber of the same uid", () => {
    const store = createBlockRefStore();
    const first = vi.fn();
    const second = vi.fn();
    store.subscribe("ref_aa1", first);
    store.subscribe("ref_aa1", second);

    store.resolve({ ref_aa1: text("alpha") });

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  test("stops notifying an unsubscribed listener", () => {
    const store = createBlockRefStore();
    const onAa1 = vi.fn();
    const unsubscribe = store.subscribe("ref_aa1", onAa1);

    unsubscribe();
    store.resolve({ ref_aa1: text("alpha") });

    expect(onAa1).not.toHaveBeenCalled();
  });

  test("re-resolving a uid to an equal entry still notifies once", () => {
    const store = createBlockRefStore();
    store.resolve({ ref_aa1: text("alpha") });
    const onAa1 = vi.fn();
    store.subscribe("ref_aa1", onAa1);

    store.resolve({ ref_aa1: text("beta") });

    expect(onAa1).toHaveBeenCalledTimes(1);
    expect(store.get("ref_aa1")).toEqual(text("beta"));
  });

  test("claims a uid for fetching exactly once", () => {
    const store = createBlockRefStore();
    expect(store.claimRequest("ref_aa1")).toBe(true);
    expect(store.claimRequest("ref_aa1")).toBe(false);
    expect(store.claimRequest("ref_aa1")).toBe(false);
  });

  test("keeps claims only for uids still unresolved, bounding the set", () => {
    const store = createBlockRefStore();
    store.claimRequest("ref_aa1");
    store.claimRequest("ref_gone");
    expect(store.claimCount()).toBe(2);

    // A resolved uid can never be re-requested (its consumer stops asking),
    // so its claim is dead weight; an unknown one's claim is the guard that
    // stops a refetch loop and must stay.
    store.resolve({ ref_aa1: text("alpha") });

    expect(store.claimCount()).toBe(1);
    expect(store.claimRequest("ref_gone")).toBe(false);
  });

  test("forgetting an entry notifies its subscribers and reopens the claim", () => {
    const store = createBlockRefStore();
    store.claimRequest("ref_aa1");
    store.resolve({ ref_aa1: text("alpha") });
    const onAa1 = vi.fn();
    store.subscribe("ref_aa1", onAa1);

    store.forget("ref_aa1");

    expect(store.get("ref_aa1")).toBeUndefined();
    expect(onAa1).toHaveBeenCalledTimes(1);
    expect(store.claimRequest("ref_aa1")).toBe(true);
  });

  test("forgetting a uid it never held notifies nobody", () => {
    const store = createBlockRefStore();
    const onAa1 = vi.fn();
    store.subscribe("ref_aa1", onAa1);

    store.forget("ref_aa1");

    expect(onAa1).not.toHaveBeenCalled();
  });
});
