#!/usr/bin/env node
// pattern: Imperative Shell
// `pnpm gen-types`: reads src/api/openapi.json, generates the declarations
// through genTypes-core.mjs's x-brand transform, and writes
// src/api/types.d.ts. A malformed x-brand marker exits non-zero with the
// message rather than writing a file.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { COMMENT_HEADER } from "openapi-typescript";
import { generateTypes } from "./genTypes-core.mjs";

const API_DIR = join(dirname(dirname(fileURLToPath(import.meta.url))), "src", "api");

try {
  const spec = JSON.parse(readFileSync(join(API_DIR, "openapi.json"), "utf8"));
  const out = await generateTypes(spec);
  writeFileSync(join(API_DIR, "types.d.ts"), `${COMMENT_HEADER}${out}`, "utf8");
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
