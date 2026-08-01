// Drift probes for the generated-type API boundary (pkm-60bf). These are
// compile-time tests: `pnpm typecheck` is what runs them. Every expected-error
// directive below must stay an error -- TypeScript reports an UNUSED
// suppression as an error of its own, so a probe that stops catching its
// drift fails the build rather than silently passing.
import { expect, it } from "vitest";
import type { paths } from "./types";

// --- rename's concrete response model (was `{[key: string]: unknown}`) ---

type RenameResponse =
  paths["/api/page/{title}/rename"]["post"]["responses"][200]["content"]["application/json"];

it("types the rename response as a discriminated result", () => {
  const renamed: RenameResponse = { result: "renamed", title: "New" };
  const branch: "renamed" | "merged" = renamed.result;
  expect(branch).toBe("renamed");
});
