// Brand probes for the generated op types. Mostly a COMPILE-time test:
// `pnpm typecheck` runs it, and an unused expected-error directive is an
// error of its own, so a probe that stops catching a plain string fails
// the build rather than silently passing.
import { expect, it } from "vitest";
import { sha256Hex } from "../replica/sha256";
import type { DeleteOp, UpdateTextOp } from "./ops";

const plain: string = "x".repeat(64);

// @ts-expect-error a plain string is not a Sha256Hex
const badUpdate: UpdateTextOp = { op: "update_text", uid: "abcdef", text: "", base_text_hash: plain };
const goodUpdate: UpdateTextOp = { op: "update_text", uid: "abcdef", text: "", base_text_hash: sha256Hex("") };

// @ts-expect-error a plain string is not a Sha256Hex
const badDelete: DeleteOp = { op: "delete", uid: "abcdef", base_subtree_hash: plain };
const goodDelete: DeleteOp = { op: "delete", uid: "abcdef", base_subtree_hash: sha256Hex("") };

it("carries a branded hash through the generated op types", () => {
  expect(goodUpdate.base_text_hash).toHaveLength(64);
  expect(goodDelete.base_subtree_hash).toHaveLength(64);
  expect([badUpdate, badDelete]).toHaveLength(2);
});
