// pattern: Imperative Shell
import fc from "fast-check";
import { expect, test } from "vitest";
import { BASE_URL, PASSWORD, SEED } from "./env";
import { captureFaultWarnings } from "../warningsCapture";

captureFaultWarnings("sync smoke");

async function login(): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: PASSWORD }),
  });
  expect(res.ok).toBe(true);
  return (res.headers.getSetCookie()[0] ?? "").split(";")[0];
}

test("harness server resets to the seed blocks of both pages", async () => {
  // An earlier file may have left the server clock far past START_MS, and a
  // cookie issued there is in the future once the reset returns the clock:
  // the first login only buys the reset, the second is the one used.
  const reset = await fetch(`${BASE_URL}/__proptest/reset`, {
    method: "POST",
    headers: { cookie: await login() },
  });
  expect(reset.status).toBe(200);
  const cookie = await login();
  const snap = (await (
    await fetch(`${BASE_URL}/api/sync/snapshot`, { headers: { cookie } })
  ).json()) as { blocks: { uid: string }[] };
  expect(snap.blocks.map((b) => b.uid).sort()).toEqual(
    ["pt_sec_1", "pt_sec_2", "pt_sec_3",
     "pt_seed_1", "pt_seed_2", "pt_seed_3", "pt_seed_4", "pt_seed_5", "pt_seed_6"],
  );
});

test("fast-check is wired", () => {
  fc.assert(
    fc.property(fc.integer(), fc.integer(), (a, b) => a + b === b + a),
    { seed: SEED },
  );
});
