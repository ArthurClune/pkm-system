// The committed src/api/types.d.ts must be exactly what `pnpm gen-types`
// writes from the committed openapi.json. Regenerating with the stock
// openapi-typescript CLI, or hand-editing the file, turns every brand back
// into a plain string without any type error; this test catches that.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { COMMENT_HEADER } from "openapi-typescript";
import { expect, test } from "vitest";
import { generateTypes } from "./genTypes-core.mjs";

const apiDir = join(dirname(dirname(fileURLToPath(import.meta.url))), "src", "api");
const apiFile = (name: string) => readFileSync(join(apiDir, name), "utf8");

test("src/api/types.d.ts is current: if this fails, run `pnpm gen-types`", async () => {
  const spec: unknown = JSON.parse(apiFile("openapi.json"));
  const expected = COMMENT_HEADER + await generateTypes(spec);
  expect(apiFile("types.d.ts") === expected,
         "src/api/types.d.ts is stale or was not written by `pnpm gen-types`; run `pnpm gen-types`")
    .toBe(true);
});
