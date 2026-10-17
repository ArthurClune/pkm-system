import { expect, it } from "vitest";
import { parsePendingOps } from "./pendingOps";

it("reads a stored op list", () => {
  const ops = [{ op: "delete", uid: "abcdef" }];
  expect(parsePendingOps(JSON.stringify(ops))).toEqual(ops);
});

it("rejects text that is not a list of ops", () => {
  expect(() => parsePendingOps("{}")).toThrow("not an array");
  expect(() => parsePendingOps("[1]")).toThrow("no op kind");
  expect(() => parsePendingOps('[{"uid":"abcdef"}]')).toThrow("no op kind");
});
