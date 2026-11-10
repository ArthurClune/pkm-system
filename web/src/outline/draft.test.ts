import { describe, expect, it } from "vitest";
import { sha256Hex } from "../replica/sha256";
import { block, canonicalTitleOf, uidOf } from "../test-helpers";
import { captureDraft, pendingTextOps } from "./draft";

describe("pendingTextOps", () => {
  it("flushes a changed pending draft before a structural op", () => {
    const ops = pendingTextOps(
      { uid: uidOf("tuid-u1"), text: "typed", base: "old" }, [block("tuid-u1", "old")], canonicalTitleOf("Page"),
    );
    expect(ops).toEqual([{
      op: "update_text", uid: "tuid-u1", text: "typed",
      base_text_hash: sha256Hex("old"), page_title: "Page",
    }]);
  });

  it("drops a no-op pending draft whose text is unchanged", () => {
    expect(pendingTextOps(
      { uid: uidOf("tuid-u1"), text: "same", base: "same" }, [block("tuid-u1", "same")], canonicalTitleOf("Page"),
    )).toEqual([]);
  });

  it("flushes a draft whose block a remote batch deleted, stamped with its base", () => {
    expect(pendingTextOps(
      { uid: uidOf("tuid-gone"), text: "typed", base: "old" }, [block("tuid-u1", "old")], canonicalTitleOf("Page"),
    )).toEqual([{
      op: "update_text", uid: "tuid-gone", text: "typed",
      base_text_hash: sha256Hex("old"), page_title: "Page",
    }]);
  });

  it("has nothing to flush without a pending draft", () => {
    expect(pendingTextOps(null, [block("tuid-u1", "old")], canonicalTitleOf("Page"))).toEqual([]);
  });

  it("stamps the base, not the tree, when a remote edit landed under the draft", () => {
    const ops = pendingTextOps(
      { uid: uidOf("tuid-u1"), text: "typed", base: "old" }, [block("tuid-u1", "remote")], canonicalTitleOf("Page"),
    );
    expect(ops).toEqual([{
      op: "update_text", uid: "tuid-u1", text: "typed",
      base_text_hash: sha256Hex("old"), page_title: "Page",
    }]);
  });

  it("drops a draft typed back to its base, even over a remote edit", () => {
    expect(pendingTextOps(
      { uid: uidOf("tuid-u1"), text: "old", base: "old" }, [block("tuid-u1", "remote")], canonicalTitleOf("Page"),
    )).toEqual([]);
  });

  it("drops a draft a remote edit already made", () => {
    expect(pendingTextOps(
      { uid: uidOf("tuid-u1"), text: "same", base: "old" }, [block("tuid-u1", "same")], canonicalTitleOf("Page"),
    )).toEqual([]);
  });

  it("a draft with no captured base carries page_title and no hash", () => {
    const ops = pendingTextOps(
      { uid: uidOf("tuid-gone"), text: "typed", base: null }, [], canonicalTitleOf("Page"),
    );
    expect(ops).toEqual([
      { op: "update_text", uid: "tuid-gone", text: "typed", page_title: "Page" },
    ]);
    expect(ops[0]).not.toHaveProperty("base_text_hash");
  });
});

describe("captureDraft", () => {
  it("captures the tree text as base on the first change", () => {
    expect(captureDraft(null, uidOf("tuid-u1"), "a", [block("tuid-u1", "old")]))
      .toEqual({ uid: "tuid-u1", text: "a", base: "old" });
  });

  it("keeps the base across later changes even when the tree moved on", () => {
    expect(captureDraft(
      { uid: uidOf("tuid-u1"), text: "a", base: "old" }, uidOf("tuid-u1"), "ab", [block("tuid-u1", "remote")],
    )).toEqual({ uid: "tuid-u1", text: "ab", base: "old" });
  });

  it("recaptures for a different block", () => {
    expect(captureDraft(
      { uid: uidOf("tuid-u1"), text: "a", base: "old" }, uidOf("tuid-u2"), "x",
      [block("tuid-u1", "old"), block("tuid-u2", "two")],
    )).toEqual({ uid: "tuid-u2", text: "x", base: "two" });
  });

  it("starts from the text the editor showed, not the tree, when given one", () => {
    expect(captureDraft(null, uidOf("tuid-u1"), "firstX", [block("tuid-u1", "remote")],
                        { uid: uidOf("tuid-u1"), base: "first" }))
      .toEqual({ uid: "tuid-u1", text: "firstX", base: "first" });
  });

  it("ignores a shown text recorded for another block", () => {
    expect(captureDraft(null, uidOf("tuid-u2"), "x", [block("tuid-u2", "two")],
                        { uid: uidOf("tuid-u1"), base: "first" }))
      .toEqual({ uid: "tuid-u2", text: "x", base: "two" });
  });

  it("keeps the draft's own base over a later shown text", () => {
    expect(captureDraft({ uid: uidOf("tuid-u1"), text: "a", base: "old" }, uidOf("tuid-u1"), "ab",
                        [block("tuid-u1", "old")], { uid: uidOf("tuid-u1"), base: "a" }))
      .toEqual({ uid: "tuid-u1", text: "ab", base: "old" });
  });

  it("records a null base for a block the tree lacks", () => {
    expect(captureDraft(null, uidOf("tuid-gone"), "x", []))
      .toEqual({ uid: "tuid-gone", text: "x", base: null });
  });
});
