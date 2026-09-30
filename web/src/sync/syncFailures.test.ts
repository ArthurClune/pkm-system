import { describe, expect, test } from "vitest";
import { ApiError, OfflineError } from "../api/client";
import { ReplicaError, ReplicaUnusableError, RpcLifecycleError } from "../replica/errors";
import { isFreshCorruption, isStallShaped, isWindowFailure, PullStarvedError } from "./syncFailures";

const CORRUPT_MESSAGE = "database disk image is malformed";

const cases: Array<{
  name: string;
  error: unknown;
  stallShaped: boolean;
  windowFailure: boolean;
  freshCorruption: boolean;
}> = [
  { name: "ApiError", error: new ApiError(500, "/x"),
    stallShaped: true, windowFailure: false, freshCorruption: false },
  { name: "OfflineError", error: new OfflineError("/x"),
    stallShaped: false, windowFailure: false, freshCorruption: false },
  { name: "ReplicaError", error: new ReplicaError("x"),
    stallShaped: true, windowFailure: true, freshCorruption: false },
  { name: "ReplicaUnusableError", error: new ReplicaUnusableError("x"),
    stallShaped: false, windowFailure: false, freshCorruption: false },
  { name: "RpcLifecycleError(timeout)", error: new RpcLifecycleError("timeout", "x"),
    stallShaped: false, windowFailure: false, freshCorruption: false },
  { name: "RpcLifecycleError(disposed)", error: new RpcLifecycleError("disposed", "x"),
    stallShaped: false, windowFailure: false, freshCorruption: false },
  { name: "PullStarvedError", error: new PullStarvedError("x"),
    stallShaped: true, windowFailure: false, freshCorruption: false },
  { name: "corrupt ReplicaError", error: new ReplicaError(CORRUPT_MESSAGE),
    stallShaped: true, windowFailure: false, freshCorruption: true },
  { name: "TypeError", error: new TypeError("fetch"),
    stallShaped: false, windowFailure: false, freshCorruption: false },
  { name: "Error", error: new Error("x"),
    stallShaped: false, windowFailure: false, freshCorruption: false },
];

describe("isStallShaped", () => {
  test.each(cases)("$name -> $stallShaped", ({ error, stallShaped }) => {
    expect(isStallShaped(error)).toBe(stallShaped);
  });
});

describe("isWindowFailure", () => {
  test.each(cases)("$name -> $windowFailure", ({ error, windowFailure }) => {
    expect(isWindowFailure(error)).toBe(windowFailure);
  });
});

describe("isFreshCorruption", () => {
  test.each(cases)("$name, alreadyRebuilt=false -> $freshCorruption",
    ({ error, freshCorruption }) => {
      expect(isFreshCorruption(error, false)).toBe(freshCorruption);
    });

  // The budget is spent: every case reads false once a rebuild already
  // happened this session, including the corrupt ReplicaError.
  test.each(cases)("$name, alreadyRebuilt=true -> false", ({ error }) => {
    expect(isFreshCorruption(error, true)).toBe(false);
  });
});
