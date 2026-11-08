import { describe, expect, test } from "vitest";
import { makeGiveWay } from "./giveWay";

describe("makeGiveWay", () => {
  test("pauses only once the interval has passed since the last pause", async () => {
    let t = 0;
    const giveWay = makeGiveWay(1_000, () => t);
    t = 999;
    expect(giveWay()).toBeUndefined();
    t = 1_000;
    const pause = giveWay();
    expect(pause).toBeInstanceOf(Promise);
    await pause;
    t = 1_999;
    expect(giveWay()).toBeUndefined();
    t = 2_000;
    expect(giveWay()).toBeInstanceOf(Promise);
  });

  test("the pause settles only after a macrotask has run", async () => {
    let t = 0;
    const giveWay = makeGiveWay(1, () => t);
    t = 1;
    const order: string[] = [];
    setImmediate(() => order.push("macrotask"));
    await giveWay();
    order.push("resumed");
    expect(order).toEqual(["macrotask", "resumed"]);
  });
});
