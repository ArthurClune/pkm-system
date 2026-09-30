import { describe, expect, test } from "vitest";
import { availabilityOf, isCorruptionError, isSessionFatal,
         isUnreadableFileMessage, ReplicaError, ReplicaUnusableError,
         RpcLifecycleError } from "./errors";

describe("ReplicaError flags", () => {
  test("rejected defaults to false", () => {
    expect(new ReplicaError("boom").rejected).toBe(false);
  });

  test("rejected is carried", () => {
    expect(new ReplicaError("bad title", { rejected: true }).rejected).toBe(true);
  });

  test("an unusable error is still a ReplicaError", () => {
    // Every existing `instanceof ReplicaError` check must keep working.
    expect(new ReplicaUnusableError("no db")).toBeInstanceOf(ReplicaError);
  });
});

describe("availabilityOf", () => {
  test("the worker's own failed open is unusable", () => {
    expect(availabilityOf(new ReplicaUnusableError("no db"))).toBe("unusable");
  });

  test("a terminal RPC failure is unreachable, not unusable", () => {
    // "we could not ask" is not evidence that there is no database.
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
    expect(isSessionFatal(new ReplicaUnusableError("no db"))).toBe(true);
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
    expect(isSessionFatal(new ReplicaError("disk I/O error"))).toBe(false);
  });
});

describe("isCorruptionError", () => {
  test("recognises SQLite corruption reported through a replica error", () => {
    // What FTS5 raises when its index and content table disagree;
    // the wrapper surfaces the engine's message unchanged.
    expect(isCorruptionError(new ReplicaError(
      "SQLITE_CORRUPT_VTAB: sqlite3 result code 267: database disk image is malformed",
    ))).toBe(true);
    expect(isCorruptionError(new ReplicaError(
      "SQLITE_CORRUPT: sqlite3 result code 11: database disk image is malformed",
    ))).toBe(true);
  });

  test("ignores every other failure", () => {
    expect(isCorruptionError(new ReplicaError(
      "SQLITE_CONSTRAINT_UNIQUE: sqlite3 result code 2067: UNIQUE constraint failed: pages.title",
    ))).toBe(false);
    // a latched failed open is unusable, never a rebuild trigger
    expect(isCorruptionError(new ReplicaUnusableError(
      "database disk image is malformed"))).toBe(false);
    expect(isCorruptionError(new Error("database disk image is malformed"))).toBe(false);
    expect(isCorruptionError("SQLITE_CORRUPT")).toBe(false);
  });
});

describe("isUnreadableFileMessage", () => {
  test("recognises a file SQLite cannot read as a database", () => {
    for (const message of [
      "SQLITE_NOTADB: sqlite3 result code 26: file is not a database",
      "SQLITE_CORRUPT: sqlite3 result code 11: database disk image is malformed",
      "SQLITE_CORRUPT_VTAB: sqlite3 result code 267: database disk image is malformed",
    ]) {
      expect(isUnreadableFileMessage(message), message).toBe(true);
    }
  });

  test("ignores contention and transient I/O", () => {
    for (const message of [
      "SQLITE_BUSY: sqlite3 result code 5: database is locked",
      "SQLITE_IOERR: sqlite3 result code 10: disk I/O error",
      "SQLITE_CANTOPEN: sqlite3 result code 14: unable to open database file",
      "replica pool not installed",
    ]) {
      expect(isUnreadableFileMessage(message), message).toBe(false);
    }
  });
});
