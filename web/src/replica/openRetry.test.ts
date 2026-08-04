import { describe, expect, it, vi } from "vitest";
import { isSahPoolContention, openWithRetry,
         SAH_POOL_INSTALL_OPTIONS } from "./openRetry";

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

  // sqlite-wasm memoises installOpfsSAHPoolVfs per VFS name and, by default,
  // re-awaits (and so rethrows) a cached REJECTION on every later call —
  // dist/index.mjs:
  //   if (initPromises[vfsName]) try { return await initPromises[vfsName]; }
  //   catch (e) {
  //     if (options.forceReinitIfPreviouslyFailed) delete initPromises[vfsName];
  //     else throw e;
  //   }
  // This fake reproduces exactly that contract, so the two tests below show
  // what openWithRetry's backoff is and isn't able to recover from.
  const fakeSqliteWasm = () => {
    const initPromises = new Map<string, Promise<string>>();
    let installs = 0;
    return {
      installs: () => installs,
      install: async (options: { name: string;
                                 forceReinitIfPreviouslyFailed?: boolean }) => {
        const cached = initPromises.get(options.name);
        if (cached !== undefined) {
          try {
            return await cached;
          } catch (error: unknown) {
            if (!options.forceReinitIfPreviouslyFailed) throw error;
            initPromises.delete(options.name);
          }
        }
        const attempt = (async () => {
          installs += 1;
          // Contention only on the first real attempt: the outgoing worker's
          // handles are released by the time a second one reaches OPFS.
          if (installs === 1) throw sahError;
          return "pool";
        })();
        initPromises.set(options.name, attempt);
        return await attempt;
      },
    };
  };

  it("really re-attempts the pool install, because the options drop the "
     + "cached failure", async () => {
    const sleep = vi.fn(async () => undefined);
    const sqlite = fakeSqliteWasm();
    await expect(openWithRetry(
      () => sqlite.install({ ...SAH_POOL_INSTALL_OPTIONS }),
      { sleep, delaysMs: [1, 1, 1] },
    )).resolves.toBe("pool");
    // Two attempts that actually touched OPFS, not one attempt reported twice.
    expect(sqlite.installs()).toBe(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("would retry a cached rejection forever without that option", async () => {
    const sleep = vi.fn(async () => undefined);
    const sqlite = fakeSqliteWasm();
    await expect(openWithRetry(
      () => sqlite.install({ name: SAH_POOL_INSTALL_OPTIONS.name }),
      { sleep, delaysMs: [1, 1, 1] },
    )).rejects.toBe(sahError);
    // Every retry replayed the memoised rejection: OPFS was touched once, so
    // the backoff could never see the contention clear (pkm-wi25).
    expect(sqlite.installs()).toBe(1);
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
