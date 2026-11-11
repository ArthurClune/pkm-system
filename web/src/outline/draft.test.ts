import { describe, expect, it } from "vitest";
import { sha256Hex } from "../replica/sha256";
import { block, canonicalTitleOf, uidOf } from "../test-helpers";
import { openDraft, pendingTextOps } from "./draft";

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
});

describe("openDraft", () => {
  it("opens on the shown text as both base and text", () => {
    expect(openDraft(uidOf("tuid-u1"), "shown"))
      .toEqual({ uid: "tuid-u1", text: "shown", base: "shown" });
  });
});
