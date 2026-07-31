import { afterEach, expect, test, vi } from "vitest";
import { newUid } from "./uid";

test("uids match the server's UID_RE and don't collide", () => {
  const uids = Array.from({ length: 200 }, () => newUid());
  for (const uid of uids) expect(uid).toMatch(/^[a-zA-Z0-9_-]{6,32}$/);
  for (const uid of uids) expect(uid[0]).toMatch(/^[a-zA-Z0-9]$/);
  expect(new Set(uids).size).toBe(200);
});

afterEach(() => {
  vi.restoreAllMocks();
});

test("resamples the first byte until it lands on an alphanumeric symbol", () => {
  // argparse on the Python CLI reads a bare uid starting with '-' as an
  // option (pkm-y5yv); the web minter must never hand out one either. Drive
  // crypto.getRandomValues through two rejected first bytes ('-', then '_')
  // before an accepted one, deterministically -- not relying on the ~1-in-32
  // chance of a bad byte actually occurring in a real run.
  const responses = [
    Uint8Array.from([63, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]),
    Uint8Array.from([62]),
    Uint8Array.from([0]),
  ];
  let call = 0;
  vi.spyOn(crypto, "getRandomValues").mockImplementation(((
    arr: Uint8Array,
  ) => {
    arr.set(responses[call++]);
    return arr;
  }) as typeof crypto.getRandomValues);

  const uid = newUid();

  expect(uid[0]).toBe("a"); // UID_ALPHABET[0]
  expect(call).toBe(3);
});
