import { expect, test } from "vitest";
import { newUid } from "./uid";

test("uids match the server's UID_RE and don't collide", () => {
  const uids = Array.from({ length: 200 }, () => newUid());
  for (const uid of uids) expect(uid).toMatch(/^[a-zA-Z0-9_-]{6,32}$/);
  expect(new Set(uids).size).toBe(200);
});
