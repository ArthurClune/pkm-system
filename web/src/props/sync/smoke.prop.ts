// pattern: Imperative Shell
import fc from "fast-check";
import { expect, test } from "vitest";
import { BASE_URL, PASSWORD, SEED } from "./env";

test("harness server resets to the six seed blocks", async () => {
  const login = await fetch(`${BASE_URL}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: PASSWORD }),
  });
  expect(login.ok).toBe(true);
  const cookie = (login.headers.getSetCookie()[0] ?? "").split(";")[0];
  const reset = await fetch(`${BASE_URL}/__proptest/reset`, {
    method: "POST",
    headers: { cookie },
  });
  expect(reset.status).toBe(200);
  const snap = (await (
    await fetch(`${BASE_URL}/api/sync/snapshot`, { headers: { cookie } })
  ).json()) as { blocks: { uid: string }[] };
  expect(snap.blocks.map((b) => b.uid).sort()).toEqual(
    ["pt_seed_1", "pt_seed_2", "pt_seed_3", "pt_seed_4", "pt_seed_5", "pt_seed_6"],
  );
});

test("fast-check is wired", () => {
  fc.assert(
    fc.property(fc.integer(), fc.integer(), (a, b) => a + b === b + a),
    { seed: SEED },
  );
});
