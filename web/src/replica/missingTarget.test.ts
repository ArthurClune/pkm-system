// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import type { BlockOp } from "../api/ops";
import { skipsOnMissingTarget } from "./missingTarget";

interface MissingTargetCase {
  name: string;
  op: BlockOp;
  block_exists: boolean;
  parent_exists: boolean;
  parent_chain?: string[];
  skip: boolean;
}

const cases = JSON.parse(readFileSync(new URL(
  "../../../shared/fixtures/missing_targets.json", import.meta.url,
), "utf-8")) as { cases: MissingTargetCase[] };

describe("skipsOnMissingTarget", () => {
  test.each(cases.cases)("$name", ({ op, block_exists, parent_exists,
                                     parent_chain = [], skip }) => {
    expect(skipsOnMissingTarget(op, block_exists, parent_exists, parent_chain))
      .toBe(skip);
  });
});
