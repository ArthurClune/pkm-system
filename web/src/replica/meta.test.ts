// @vitest-environment node
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { canonicalTitle, setPlainSpaceTitleCanonicalization,
         titleReader } from "./meta";
import { openTestDb, type TestDb } from "./testDb";

let t: TestDb;
beforeEach(async () => { t = await openTestDb(); });
afterEach(() => t.close());

describe("canonicalTitle / titleReader", () => {
  test("keep boundary spaces until the plain-space flag is on", () => {
    expect(canonicalTitle(t.db, "  A  ")).toBe("  A  ");
    expect(titleReader(t.db).plainSpaceActive).toBe(false);
    setPlainSpaceTitleCanonicalization(t.db, true);
    expect(canonicalTitle(t.db, "  A  ")).toBe("A");
    const read = titleReader(t.db);
    expect(read.plainSpaceActive).toBe(true);
    expect(read(" B\t C ")).toBe("B C");
  });

  test("a reader keeps the flag it read, as one read for several titles", () => {
    const read = titleReader(t.db);
    setPlainSpaceTitleCanonicalization(t.db, true);
    expect(read("  A  ")).toBe("  A  ");
  });
});
