import { afterEach, describe, expect, test } from "vitest";
import type { Snapshot } from "../../replica/apply";
import { applySnapshot } from "../../replica/apply";
import { openTestDb, type TestDb } from "../../replica/testDb";
import { canonicalTitleOf, orderIdxOf, pageIdOf, seqOf, uidOf } from "../../test-helpers";
import { canonicaliseMintedUids, diffGraphs, fromReplica, fromSnapshot,
         opUids } from "./normalise";

type SnapBlock = Snapshot["blocks"][number];

/** A snapshot block from plain values: `tag` and `parentTag` become uids,
 * `target` a page id. */
interface LooseBlock {
  tag: string;
  parentTag?: string | null;
  order?: number;
  text?: string;
  refs?: { target: number; kind: SnapBlock["refs"][number]["kind"] }[];
}

const block = (over: LooseBlock): SnapBlock => ({
  uid: uidOf(over.tag), page_id: pageIdOf(1),
  parent_uid: over.parentTag == null ? null : uidOf(over.parentTag),
  order_idx: orderIdxOf(over.order ?? 0), text: over.text ?? "", heading: null,
  view_type: null, collapsed: 0, created_at: 100, updated_at: 100,
  refs: (over.refs ?? []).map((ref) => ({ target_page_id: pageIdOf(ref.target), kind: ref.kind })),
});

const page = (id: number, titleText: string, stamp = 100): Snapshot["pages"][number] =>
  ({ id: pageIdOf(id), title: canonicalTitleOf(titleText), created_at: stamp, updated_at: stamp });

const snapshot = (blocks: SnapBlock[], over: Partial<Snapshot> = {}): Snapshot => ({
  generation: "g1", plain_space_title_canonicalization: true, seq: seqOf(7),
  pages: [page(1, "Proptest"), page(2, "Target")],
  blocks, sidebar: [],
  ...over,
});

const base = (): Snapshot => snapshot([
  block({ tag: "pt_seed_1", text: "one [[Target]]", order: 0,
          refs: [{ target: 2, kind: "link" }] }),
  block({ tag: "pt_seed_2", text: "two", order: 10 }),
  block({ tag: "pt_child", parentTag: "pt_seed_1", text: "child" }),
]);

describe("fromSnapshot", () => {
  test("names pages and ref targets by title and sorts blocks by uid", () => {
    const g = fromSnapshot(base());
    expect(g.pages).toEqual(["Proptest", "Target"]);
    expect(g.blocks.map((b) => b.key)).toEqual(["pt_child", "pt_seed_1", "pt_seed_2"]);
    expect(g.blocks[1]).toEqual({
      key: "pt_seed_1", page: "Proptest", parentKey: null, order_idx: orderIdxOf(0),
      text: "one [[Target]]", heading: null, collapsed: 0, view_type: null,
      refs: ["link:Target"],
    });
  });

  test("leaves timestamps out unless asked for", () => {
    const later = base();
    later.blocks[0] = { ...later.blocks[0], updated_at: 999 };
    later.pages[0] = { ...later.pages[0], created_at: 5 };
    expect(diffGraphs(fromSnapshot(base()), fromSnapshot(later))).toBeNull();
    const diff = diffGraphs(fromSnapshot(base(), { timestamps: true }),
                            fromSnapshot(later, { timestamps: true }));
    expect(diff).toMatch(/block pt_seed_1: stamps/);
    expect(diff).toMatch(/page Proptest: stamps/);
  });

  test("ignores page ids: the same graph under other ids is equal", () => {
    const renumbered = snapshot(
      base().blocks.map((b) => ({
        ...b,
        page_id: pageIdOf(b.page_id === 1 ? 41 : 42),
        refs: b.refs.map((r) => ({ ...r, target_page_id: pageIdOf(42) })),
      })),
      { pages: [page(41, "Proptest", 1), page(42, "Target", 1)] },
    );
    expect(diffGraphs(fromSnapshot(base()), fromSnapshot(renumbered))).toBeNull();
  });
});

describe("diffGraphs", () => {
  test("equal graphs give null", () => {
    expect(diffGraphs(fromSnapshot(base()), fromSnapshot(base()))).toBeNull();
  });

  test("one changed text names the uid and both values", () => {
    const changed = base();
    changed.blocks[1] = { ...changed.blocks[1], text: "TWO" };
    const diff = diffGraphs(fromSnapshot(base()), fromSnapshot(changed),
                            ["replica A", "server"]);
    expect(diff).toBe('block pt_seed_2: text "two" (replica A) vs "TWO" (server)');
  });

  test("reports blocks and pages present on one side only", () => {
    const fewer = snapshot([base().blocks[0]], {
      pages: [base().pages[0], page(3, "Other", 1)],
    });
    const diff = diffGraphs(fromSnapshot(base()), fromSnapshot(fewer)) ?? "";
    expect(diff).toContain("page Target: only in a");
    expect(diff).toContain("page Other: only in b");
    expect(diff).toContain("block pt_child: only in a");
    expect(diff).toContain("block pt_seed_2: only in a");
  });
});

describe("canonicaliseMintedUids", () => {
  const withMinted = (header: string, entry: string): Snapshot => snapshot([
    ...base().blocks,
    block({ tag: header, text: "[[conflict]] header", order: 20 }),
    block({ tag: entry, parentTag: header, text: `lost text ((pt_seed_1)) under ${header}` }),
  ]);
  const known = new Set(["pt_seed_1", "pt_seed_2", "pt_child"]);

  test("names server-minted uids by position, so two mintings compare equal", () => {
    const one = canonicaliseMintedUids(fromSnapshot(withMinted("Xmint1", "Xmint2")), known);
    const two = canonicaliseMintedUids(fromSnapshot(withMinted("Ymint1", "Ymint2")), known);
    expect(diffGraphs(one, two)).toBeNull();
    const entry = one.blocks.find((b) => b.text.startsWith("lost text"));
    expect(entry?.parentKey).toBe("~[Proptest]/20");
    expect(entry?.text).toBe("lost text ((pt_seed_1)) under ~[Proptest]/20");
  });

  test("still sees a difference in a minted block's content", () => {
    const one = canonicaliseMintedUids(fromSnapshot(withMinted("Xmint1", "Xmint2")), known);
    const other = withMinted("Ymint1", "Ymint2");
    other.blocks[3] = { ...other.blocks[3], text: "[[conflict]] other header" };
    const two = canonicaliseMintedUids(fromSnapshot(other), known);
    expect(diffGraphs(one, two)).toMatch(/block ~\[Proptest\]\/20: text/);
  });
});

describe("opUids", () => {
  test("collects every uid and parent uid an ops body names", () => {
    const body = JSON.stringify({
      client_id: "c", batch_id: "b",
      ops: [
        { op: "create", uid: "pt_A_1", parent_uid: "pt_seed_1", page_title: "P", order_idx: 0, text: "" },
        { op: "move", uid: "pt_seed_2", parent_uid: null, order_idx: 0 },
      ],
    });
    expect([...opUids(body)].sort()).toEqual(["pt_A_1", "pt_seed_1", "pt_seed_2"]);
  });
});

describe("fromReplica", () => {
  let t: TestDb | null = null;
  afterEach(() => { t?.close(); t = null; });

  test("reads the same graph a snapshot applied to the replica holds", async () => {
    t = await openTestDb();
    applySnapshot(t.db, base());
    expect(diffGraphs(fromReplica(t.db), fromSnapshot(base()))).toBeNull();
  });

  test("names a page the replica does not hold as `?page N`, as a snapshot does", async () => {
    t = await openTestDb();
    applySnapshot(t.db, base());
    t.db.exec("PRAGMA foreign_keys = OFF");
    t.db.exec("DELETE FROM pages WHERE id = 1");
    const gone = fromReplica(t.db);
    expect(gone.blocks.some((b) => b.page === "?page 1")).toBe(true);
    expect(gone.pages).not.toContain("?page 1");
    const snap = base();
    snap.pages = snap.pages.filter((p) => p.id !== pageIdOf(1));
    expect(diffGraphs(gone, fromSnapshot(snap))).toBeNull();
  });
});
