import { describe, expect, it, vi } from "vitest";
import { isSahPoolContention, openWithRetry } from "./openRetry";

const sahError = new Error(
  "Failed to execute 'createSyncAccessHandle' on 'FileSystemFileHandle': "
  + "Access Handles cannot be created if there is another open Access Handle "
  + "or Writable stream associated with the same file.");

describe("isSahPoolContention", () => {
  it("recognises the OPFS access-handle contention message", () => {
    expect(isSahPoolContention(sahError)).toBe(true);
    expect(isSahPoolContention(new Error("createSyncAccessHandle failed"))).toBe(true);
  });

  it("does not match unrelated errors", () => {
    expect(isSahPoolContention(new Error("disk I/O error"))).toBe(false);
    expect(isSahPoolContention("some string")).toBe(false);
    expect(isSahPoolContention(undefined)).toBe(false);
  });
});

describe("openWithRetry", () => {
  it("returns immediately when the open succeeds first try", async () => {
    const sleep = vi.fn(async () => undefined);
    const open = vi.fn(async () => "db");
    await expect(openWithRetry(open, { sleep })).resolves.toBe("db");
    expect(open).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries through transient contention then succeeds", async () => {
    const sleep = vi.fn(async () => undefined);
    let calls = 0;
    const open = vi.fn(async () => {
      calls += 1;
      if (calls <= 3) throw sahError;
      return "db";
    });
    await expect(
      openWithRetry(open, { sleep, delaysMs: [1, 1, 1, 1, 1] }),
    ).resolves.toBe("db");
    expect(open).toHaveBeenCalledTimes(4);
    expect(sleep).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenNthCalledWith(1, 1);
  });

  it("rethrows a non-retryable error without sleeping", async () => {
    const sleep = vi.fn(async () => undefined);
    const boom = new Error("disk I/O error");
    const open = vi.fn(async () => { throw boom; });
    await expect(openWithRetry(open, { sleep })).rejects.toBe(boom);
    expect(open).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("gives up after exhausting the schedule and rethrows the last error", async () => {
    const sleep = vi.fn(async () => undefined);
    const open = vi.fn(async () => { throw sahError; });
    await expect(
      openWithRetry(open, { sleep, delaysMs: [1, 1] }),
    ).rejects.toBe(sahError);
    // one initial attempt + two retries = three opens, two sleeps
    expect(open).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("honours a custom isRetryable predicate", async () => {
    const sleep = vi.fn(async () => undefined);
    let calls = 0;
    const open = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error("custom-transient");
      return "db";
    });
    await expect(
      openWithRetry(open, {
        sleep,
        delaysMs: [1],
        isRetryable: (e) => e instanceof Error && e.message === "custom-transient",
      }),
    ).resolves.toBe("db");
    expect(open).toHaveBeenCalledTimes(2);
  });
});
