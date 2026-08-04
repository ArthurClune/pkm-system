import { describe, expect, test } from "vitest";
import { availabilityOf, isSessionFatal, ReplicaError,
         ReplicaUnavailableError, RpcLifecycleError } from "./errors";

describe("ReplicaError flags", () => {
  test("both flags default to false", () => {
    const error = new ReplicaError("boom");
    expect(error.quota).toBe(false);
    expect(error.rejected).toBe(false);
  });

  test("flags are carried independently", () => {
    expect(new ReplicaError("full", { quota: true }).quota).toBe(true);
    expect(new ReplicaError("bad title", { rejected: true }).rejected).toBe(true);
    expect(new ReplicaError("full", { quota: true }).rejected).toBe(false);
  });

  test("an unavailable error is still a ReplicaError", () => {
    // Every existing `instanceof ReplicaError` check must keep working.
    expect(new ReplicaUnavailableError("no db")).toBeInstanceOf(ReplicaError);
  });
});

describe("availabilityOf", () => {
  test("the worker's own failed open is unusable", () => {
    expect(availabilityOf(new ReplicaUnavailableError("no db"))).toBe("unusable");
  });

  test("a terminal RPC failure is unreachable, not unusable", () => {
    // "we could not ask" is not evidence that there is no database (pkm-bjae).
    for (const kind of ["worker-error", "message-error", "timeout", "disposed"] as const) {
      expect(availabilityOf(new RpcLifecycleError(kind, kind))).toBe("unreachable");
    }
  });

  test("an ordinary replica error is not an availability failure", () => {
    expect(availabilityOf(new ReplicaError("SQLITE_CANTOPEN"))).toBeNull();
    expect(availabilityOf(new Error("something else"))).toBeNull();
    expect(availabilityOf("not an error")).toBeNull();
  });
});

describe("isSessionFatal", () => {
  test("a latched open failure is fatal for the session", () => {
    expect(isSessionFatal(new ReplicaUnavailableError("no db"))).toBe(true);
  });

  test("a timeout is NOT fatal: one slow call is not a dead replica", () => {
    // createRpcClient only latches `terminal` for worker-error/message-error/
    // disposed; the timeout path leaves the client usable (rpc.ts).
    expect(isSessionFatal(new RpcLifecycleError("timeout", "timed out"))).toBe(false);
  });

  test("a terminally failed RPC client is fatal", () => {
    for (const kind of ["worker-error", "message-error", "disposed"] as const) {
      expect(isSessionFatal(new RpcLifecycleError(kind, kind))).toBe(true);
    }
  });

  test("a non-availability error is never session-fatal", () => {
    expect(isSessionFatal(new ReplicaError("disk full", { quota: true }))).toBe(false);
  });
});
