// Brand probes for the generated op types. The typeProbe block is a
// COMPILE-time check: `pnpm typecheck` runs it, and an unused expected-error
// directive is an error of its own, so a probe that stops catching a plain
// string fails the build rather than silently passing.
import { expect, it } from "vitest";
import { sha256Hex } from "../replica/sha256";
import type { DeleteOp, UpdateTextOp } from "./ops";
import { typeProbe, uidOf } from "../test-helpers";

const plain: string = "x".repeat(64);

typeProbe(() => {
  // @ts-expect-error a plain string is not a Sha256Hex
  const badUpdate: UpdateTextOp = { op: "update_text", uid: uidOf("abcdef"), text: "", base_text_hash: plain };
  // @ts-expect-error a plain string is not a Sha256Hex
  const badDelete: DeleteOp = { op: "delete", uid: uidOf("abcdef"), base_subtree_hash: plain };
  void [badUpdate, badDelete];
});

const goodUpdate: UpdateTextOp = { op: "update_text", uid: uidOf("abcdef"), text: "", base_text_hash: sha256Hex("") };
const goodDelete: DeleteOp = { op: "delete", uid: uidOf("abcdef"), base_subtree_hash: sha256Hex("") };

it("carries a branded hash through the generated op types", () => {
  expect(goodUpdate.base_text_hash).toHaveLength(64);
  expect(goodDelete.base_subtree_hash).toHaveLength(64);
});
