import { expect, it } from "vitest";
import { createBoundedCache } from "./renderCache";

it("returns undefined for a miss and the stored value for a hit", () => {
  const cache = createBoundedCache<string>(10);
  expect(cache.get("a")).toBeUndefined();
  cache.set("a", "1");
  expect(cache.get("a")).toBe("1");
});

it("tracks size across sets, including overwrites of an existing key", () => {
  const cache = createBoundedCache<string>(10);
  cache.set("a", "1");
  cache.set("b", "2");
  expect(cache.size()).toBe(2);
  cache.set("a", "1-updated");
  expect(cache.size()).toBe(2);
  expect(cache.get("a")).toBe("1-updated");
});

it("clears the whole cache once it reaches the limit, rather than evicting one entry", () => {
  const cache = createBoundedCache<string>(2);
  cache.set("a", "1");
  cache.set("b", "2");
  expect(cache.size()).toBe(2);
  cache.set("c", "3"); // hits the limit -> full clear, then inserts c
  expect(cache.size()).toBe(1);
  expect(cache.get("a")).toBeUndefined();
  expect(cache.get("b")).toBeUndefined();
  expect(cache.get("c")).toBe("3");
});

it("clear() empties the cache on demand", () => {
  const cache = createBoundedCache<string>(10);
  cache.set("a", "1");
  cache.clear();
  expect(cache.size()).toBe(0);
  expect(cache.get("a")).toBeUndefined();
});

it("keeps separate instances independent", () => {
  const first = createBoundedCache<number>(10);
  const second = createBoundedCache<number>(10);
  first.set("a", 1);
  expect(second.get("a")).toBeUndefined();
  expect(second.size()).toBe(0);
});
