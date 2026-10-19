import { describe, expect, test } from "vitest";
import { keyColumnsMessage, rowCheckMessage, rowProblems } from "./rowCheck";

const UID = "abcDEF_123-";
const HASH = "a".repeat(64);

describe("rowProblems", () => {
  test("a well-formed row has none", () => {
    expect(rowProblems({
      uid: UID, parent_uid: null, page_id: 3, text: "x", heading: 2,
      view_type: "numbered", sha256: HASH, n: 0,
    })).toEqual([]);
  });

  test("a column that is not a key is named", () => {
    expect(rowProblems({ id: 1 })).toEqual(["id: not a registered row key"]);
  });

  test("NULL in a non-nullable key", () => {
    expect(rowProblems({ uid: null })).toEqual(["uid: NULL for a non-null key"]);
    expect(rowProblems({ parent_uid: null })).toEqual([]);
  });

  test("a wrong base type; a boolean is never a number", () => {
    expect(rowProblems({ page_id: "3" })).toEqual(["page_id: expected int, got string"]);
    expect(rowProblems({ text: 3 })).toEqual(["text: expected text, got number"]);
    expect(rowProblems({ page_id: 1.5 })).toEqual(["page_id: expected int, got number"]);
    expect(rowProblems({ n: true })).toEqual(["n: bool true is not int"]);
  });

  test("a brand value that fails its shape", () => {
    expect(rowProblems({ uid: "a" })).toEqual(['uid: "a" is not a valid BlockUid']);
    expect(rowProblems({ uid: `${UID}!` })).toHaveLength(1);
    expect(rowProblems({ sha256: "ABC" })).toEqual(['sha256: "ABC" is not a valid Sha256Hex']);
  });

  test("a Literal key value outside its literals", () => {
    expect(rowProblems({ heading: 4 })[0]).toContain("heading: 4 is not one of 0, 1, 2, 3");
    expect(rowProblems({ view_type: "bogus" })[0]).toContain("is not one of");
    expect(rowProblems({ ref_kind: "tag" })).toEqual([]);
  });

  test("one message per offending column", () => {
    expect(rowProblems({ id: 1, uid: "a", text: null })).toHaveLength(3);
  });
});

describe("rowCheckMessage", () => {
  test("names the query and the fix", () => {
    const msg = rowCheckMessage("SELECT  id\n FROM pages", ["id: not a registered row key"]);
    expect(msg).toContain("'SELECT id FROM pages'");
    expect(msg).toContain("alias the column to a key of Columns");
  });
});

describe("keyColumnsMessage", () => {
  const sql = "SELECT uid,\n  text FROM blocks";

  test("the same set, in any order, is fine", () => {
    expect(keyColumnsMessage(sql, ["uid", "text"], ["text", "uid"])).toBeNull();
    expect(keyColumnsMessage(sql, ["uid"], ["uid"])).toBeNull();
  });

  test("a key the query does not return is named", () => {
    const m = keyColumnsMessage(sql, ["uid", "text"], ["uid"]);
    expect(m).toContain("named but not returned: text");
    expect(m).not.toContain("returned but not named");
    expect(m).toContain("'SELECT uid, text FROM blocks'");
    expect(m).toContain("Fix the call");
  });

  test("a column no key names is named", () => {
    const m = keyColumnsMessage(sql, ["uid"], ["uid", "text"]);
    expect(m).toContain("returned but not named: text");
    expect(m).not.toContain("named but not returned");
  });

  test("a duplicate key is refused", () => {
    expect(keyColumnsMessage(sql, ["uid", "uid"], ["uid"]))
      .toContain("a key is named twice: uid, uid");
  });
});
