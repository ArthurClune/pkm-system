import { expect, it } from "vitest";
import { parsePendingOps } from "./pendingOps";

it("reads back a stored op list", () => {
  const ops = [{ op: "delete", uid: "abcdef" }];
  expect(parsePendingOps(JSON.stringify(ops))).toEqual(ops);
});
