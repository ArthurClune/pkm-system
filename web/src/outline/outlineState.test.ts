import { describe, expect, it, vi } from "vitest";
import type { BlockOp } from "../api/ops";
import type { BlockNode } from "../api/payloads";
import { block } from "../test-helpers";
import {
  beginAuthoritativeRead,
  createOutlineState,
  pendingTextOps,
  spliceUploadedMarkdown,
  transitionOutline,
  validateOutlineFocus,
} from "./outlineState";
import { findNode } from "./tree";

const update = (text: string): BlockOp => ({
  op: "update_text", uid: "u1", text,
});

describe("outline causality", () => {
  it("increments revision only for state-changing local and remote ops", () => {
    const initial = createOutlineState("Page", [block("u1", "old")]);
    const local = transitionOutline(initial, {
      type: "local-ops", ticketId: "write-1", nowMs: 0, ops: [update("local")],
    }).state;
    const unrelated = transitionOutline(local, {
      type: "remote-ops", nowMs: 0, ops: [{ op: "delete", uid: "another-page" }],
    }).state;
    const remote = transitionOutline(unrelated, {
      type: "remote-ops", nowMs: 0, ops: [update("remote")],
    }).state;

    expect(local.revision).toBe(1);
    expect(unrelated.revision).toBe(1);
    expect(remote.revision).toBe(2);
  });

  it("adopts the newest response when its dispatch revision is unchanged", () => {
    const started = beginAuthoritativeRead(
      createOutlineState("Page", [block("u1", "old")]),
    );

    const result = transitionOutline(started.state, {
      type: "authoritative",
      token: started.token,
      blocks: [block("u1", "server")],
    });

    expect(result.state.blocks[0].text).toBe("server");
    expect(result.state.deferredAuthoritative).toBeNull();
    expect(result.effects).toEqual([]);
  });

  it("defers a response dispatched before a local edit", () => {
    const started = beginAuthoritativeRead(
      createOutlineState("Page", [block("u1", "old")]),
    );
    const edited = transitionOutline(started.state, {
      type: "local-ops", ticketId: "write-1", nowMs: 0, ops: [update("local")],
    }).state;

    const result = transitionOutline(edited, {
      type: "authoritative",
      token: started.token,
      blocks: [block("u1", "stale")],
    });

    expect(result.state.blocks[0].text).toBe("local");
    expect(result.state.deferredAuthoritative?.blocks[0].text).toBe("stale");
  });

  it("requests a replacement when a remote revision advanced after dispatch", () => {
    const started = beginAuthoritativeRead(
      createOutlineState("Page", [block("u1", "old")]),
    );
    const remote = transitionOutline(started.state, {
      type: "remote-ops", nowMs: 0, ops: [update("remote")],
    }).state;

    const result = transitionOutline(remote, {
      type: "authoritative", token: started.token,
      blocks: [block("u1", "stale")],
    });

    expect(result.state.blocks[0].text).toBe("remote");
    expect(result.effects).toEqual([{
      type: "request-authoritative", reason: "revision-advanced",
    }]);
  });

  it("retains only the newest deferred authoritative payload", () => {
    const first = beginAuthoritativeRead(
      createOutlineState("Page", [block("u1", "old")]),
    );
    const second = beginAuthoritativeRead(first.state);
    const pending = transitionOutline(second.state, {
      type: "write-started", ticketId: "write-1", scope: ["page", "Page"],
      replay: [],
    }).state;
    const afterFirst = transitionOutline(pending, {
      type: "authoritative", token: first.token,
      blocks: [block("u1", "first")],
    }).state;
    const afterSecond = transitionOutline(afterFirst, {
      type: "authoritative", token: second.token,
      blocks: [block("u1", "second")],
    }).state;

    expect(afterSecond.deferredAuthoritative?.token).toEqual(second.token);
    expect(afterSecond.deferredAuthoritative?.blocks[0].text).toBe("second");
  });

  it("replaces a candidate that arrived while a relevant ticket was blocked", () => {
    const started = beginAuthoritativeRead(
      createOutlineState("Page", [block("u1", "old")]),
    );
    const pending = transitionOutline(started.state, {
      type: "write-started", ticketId: "write-1", scope: ["page", "Page"],
      replay: [],
    }).state;
    const deferred = transitionOutline(pending, {
      type: "authoritative", token: started.token,
      blocks: [block("u1", "server")],
    }).state;

    const result = transitionOutline(deferred, {
      type: "write-settled", ticketId: "write-1",
    });

    expect(result.state.blocks[0].text).toBe("old");
    expect(result.state.deferredAuthoritative).toBeNull();
    expect(result.effects).toEqual([{
      type: "request-authoritative", reason: "write-settled",
    }]);
  });

  it("never adopts a pre-delivery response dispatched after the local edit", () => {
    const edited = transitionOutline(
      createOutlineState("Page", [block("u1", "old")]),
      { type: "local-ops", ticketId: "write-1", nowMs: 0,
        ops: [update("local")] },
    ).state;
    const started = beginAuthoritativeRead(edited);
    const deferred = transitionOutline(started.state, {
      type: "authoritative", token: started.token,
      blocks: [block("u1", "pre-delivery")],
    }).state;

    const result = transitionOutline(deferred, {
      type: "write-settled", ticketId: "write-1",
    });

    expect(result.state.blocks[0].text).toBe("local");
    expect(result.state.deferredAuthoritative).toBeNull();
    expect(result.effects).toEqual([{
      type: "request-authoritative", reason: "write-settled",
    }]);
  });

  it("does not let an unrelated-title ticket block safe adoption", () => {
    const started = beginAuthoritativeRead(
      createOutlineState("Page A", [block("u1", "old")]),
    );
    const unrelated = transitionOutline(started.state, {
      type: "write-started", ticketId: "write-b",
      scope: ["page", "Page B"], replay: [],
    }).state;

    const result = transitionOutline(unrelated, {
      type: "authoritative", token: started.token,
      blocks: [block("u1", "server")],
    });

    expect(result.state.blocks[0].text).toBe("server");
    expect(result.state.relevantWrites.size).toBe(0);
  });

  it("ignores a stale transport token once a newer request exists", () => {
    const first = beginAuthoritativeRead(
      createOutlineState("Page", [block("u1", "old")]),
    );
    const second = beginAuthoritativeRead(first.state);

    const result = transitionOutline(second.state, {
      type: "authoritative", token: first.token,
      blocks: [block("u1", "stale")],
    });

    expect(result.state.blocks[0].text).toBe("old");
    expect(result.state.deferredAuthoritative).toBeNull();
  });

  it("invalidates focus when an adopted tree no longer contains its uid", () => {
    expect(validateOutlineFocus(
      { uid: "gone", cursor: 2 }, [block("kept", "text")],
    )).toBeNull();
    expect(validateOutlineFocus(
      { uid: "kept", cursor: 2 }, [block("kept", "text")],
    )).toEqual({ uid: "kept", cursor: 2 });
  });

  it("requests one fresh read instead of adopting a pre-edit candidate", () => {
    const started = beginAuthoritativeRead(
      createOutlineState("Page", [block("u1", "old")]),
    );
    const edited = transitionOutline(started.state, {
      type: "local-ops", ticketId: "write-1", nowMs: 0, ops: [update("local")],
    }).state;
    const deferred = transitionOutline(edited, {
      type: "authoritative", token: started.token,
      blocks: [block("u1", "stale")],
    }).state;

    const once = transitionOutline(deferred, {
      type: "write-settled", ticketId: "write-1",
    });
    const twice = transitionOutline(once.state, {
      type: "write-settled", ticketId: "write-1",
    });

    expect(once.state.blocks[0].text).toBe("local");
    expect(once.effects).toEqual([{
      type: "request-authoritative", reason: "write-settled",
    }]);
    expect(twice.effects).toEqual([]);
  });

  it("authoritative repair adopts server state and reapplies only unresolved ops", () => {
    const initial = createOutlineState("Page", [
      block("u1", "old"), block("u2", "old other", { order_idx: 1 }),
    ]);
    const rejected = transitionOutline(initial, {
      type: "local-ops", ticketId: "rejected", nowMs: 0,
      ops: [{ op: "update_text", uid: "u2", text: "rejected local" }],
    }).state;
    const later = transitionOutline(rejected, {
      type: "local-ops", ticketId: "later", nowMs: 0,
      ops: [{ op: "update_text", uid: "u1", text: "later local" }],
    }).state;
    const rejectedSettled = transitionOutline(later, {
      type: "write-settled", ticketId: "rejected",
    }).state;
    const started = beginAuthoritativeRead(rejectedSettled);

    const repaired = transitionOutline(started.state, {
      type: "authoritative-repair", token: started.token,
      blocks: [
        block("u1", "server before later"),
        block("u2", "server repaired", { order_idx: 1 }),
      ],
    });

    expect(repaired.state.blocks.map((node) => node.text)).toEqual([
      "later local", "server repaired",
    ]);
    expect(repaired.state.relevantWrites).toEqual(new Set(["later"]));
  });

  it("rejects a repair response when the revision advanced after dispatch", () => {
    const started = beginAuthoritativeRead(
      createOutlineState("Page", [block("u1", "old")]),
    );
    const advanced = transitionOutline(started.state, {
      type: "remote-ops", nowMs: 0, ops: [update("remote advance")],
    }).state;

    const stale = transitionOutline(advanced, {
      type: "authoritative-repair", token: started.token,
      blocks: [block("u1", "stale repair")],
    });

    expect(stale.state.blocks[0].text).toBe("remote advance");
    expect(stale.state.revision).toBe(advanced.revision);
  });

  it("replays an explicit target subtree before later ticket operations", () => {
    const targetParent = block("target", "target", { children: [] });
    const moved = block("moved", "moved", {
      children: [block("child", "child")],
    });
    const initial = createOutlineState("Target", [targetParent]);
    const moveTracked = transitionOutline(initial, {
      type: "write-started", ticketId: "move",
      scope: ["page", "Source", "Target"],
      replay: [{
        type: "insert-subtree", node: moved,
        parentUid: "target", orderIdx: 0,
      }],
    }).state;
    const childEdit = transitionOutline(moveTracked, {
      type: "local-ops", ticketId: "edit", nowMs: 0,
      ops: [{ op: "update_text", uid: "child", text: "later child edit" }],
    }).state;
    const started = beginAuthoritativeRead(childEdit);

    const repaired = transitionOutline(started.state, {
      type: "authoritative-repair", token: started.token,
      blocks: [targetParent],
    });

    expect(repaired.state.blocks[0].children[0]).toMatchObject({
      uid: "moved",
      children: [expect.objectContaining({
        uid: "child", text: "later child edit",
      })],
    });
  });

  it("relocates an already-present target subtree without duplicating it", () => {
    const moved = block("moved", "server moved");
    const target = block("target", "target", { children: [] });
    const tracked = transitionOutline(
      createOutlineState("Target", [target]),
      {
        type: "write-started", ticketId: "move",
        scope: ["page", "Source", "Target"],
        replay: [{
          type: "insert-subtree", node: moved,
          parentUid: "target", orderIdx: 0,
        }],
      },
    ).state;
    const started = beginAuthoritativeRead(tracked);

    const repaired = transitionOutline(started.state, {
      type: "authoritative-repair", token: started.token,
      blocks: [moved, target],
    });

    expect(repaired.state.blocks.map((node) => node.uid)).toEqual(["target"]);
    expect(repaired.state.blocks[0].children.map((node) => node.uid))
      .toEqual(["moved"]);
  });

  it("flushes a changed pending draft before a structural op", () => {
    const ops = pendingTextOps(
      { uid: "u1", text: "typed" }, [block("u1", "old")],
    );
    expect(ops).toEqual([{ op: "update_text", uid: "u1", text: "typed" }]);
  });

  it("drops a no-op pending draft whose text is unchanged", () => {
    expect(pendingTextOps({ uid: "u1", text: "same" }, [block("u1", "same")]))
      .toEqual([]);
  });

  it("drops a pending draft whose block a remote batch deleted", () => {
    expect(pendingTextOps({ uid: "gone", text: "typed" }, [block("u1", "old")]))
      .toEqual([]);
  });

  it("has nothing to flush without a pending draft", () => {
    expect(pendingTextOps(null, [block("u1", "old")])).toEqual([]);
  });

  it("clamps an upload splice offset past intervening typing", () => {
    // The user kept typing during a slow upload; the pre-paste offset now sits
    // beyond the (shortened) text and must clamp to its end.
    expect(spliceUploadedMarkdown("hi", 10, "[img](x)")).toEqual({
      text: "hi[img](x)", selStart: 10, selEnd: 10,
    });
  });

  it("splices uploaded markdown at the requested offset", () => {
    expect(spliceUploadedMarkdown("ab", 1, "X")).toEqual({
      text: "aXb", selStart: 2, selEnd: 2,
    });
  });

  // pkm-jk21: `local-ops` records a ticket's replay, and the delivery
  // registry then announces the same ticket with whatever replay it holds.
  // The already-relevant guard in `write-started` is the only thing standing
  // between that announcement and the recorded replay, so a rebase would
  // silently lose the local edit if the guard ever went away.
  it("keeps a recorded replay when the same ticket is announced again", () => {
    const recorded = transitionOutline(
      createOutlineState("Page", [block("u1", "old")]),
      { type: "local-ops", ticketId: "write-1", nowMs: 0,
        ops: [update("local edit")] },
    ).state;
    const announced = transitionOutline(recorded, {
      type: "write-started", ticketId: "write-1", scope: ["page", "Page"],
      replay: [],
    }).state;
    const started = beginAuthoritativeRead(announced);

    const repaired = transitionOutline(started.state, {
      type: "authoritative-repair", token: started.token,
      blocks: [block("u1", "server")],
    });

    expect(repaired.state.blocks[0].text).toBe("local edit");
  });

  it("keeps captured replay metadata when the ticket is announced again", () => {
    const target = block("target", "target", { children: [] });
    const tracked = transitionOutline(
      createOutlineState("Target", [target]),
      {
        type: "write-started", ticketId: "move",
        scope: ["page", "Source", "Target"],
        replay: [{
          type: "insert-subtree", node: block("moved", "moved"),
          parentUid: "target", orderIdx: 0,
        }],
      },
    ).state;
    const reannounced = transitionOutline(tracked, {
      type: "write-started", ticketId: "move",
      scope: ["page", "Source", "Target"], replay: [],
    }).state;
    const started = beginAuthoritativeRead(reannounced);

    const repaired = transitionOutline(started.state, {
      type: "authoritative-repair", token: started.token, blocks: [target],
    });

    expect(findNode(repaired.state.blocks, "moved")).not.toBeNull();
  });

  it("does not replay explicit subtree metadata after its ticket settles", () => {
    const target = block("target", "target", { children: [] });
    const tracked = transitionOutline(
      createOutlineState("Target", [target]),
      {
        type: "write-started", ticketId: "terminal-move",
        scope: ["page", "Source", "Target"],
        replay: [{
          type: "insert-subtree", node: block("moved", "rejected"),
          parentUid: "target", orderIdx: 0,
        }],
      },
    ).state;
    const settled = transitionOutline(tracked, {
      type: "write-settled", ticketId: "terminal-move",
    }).state;
    const started = beginAuthoritativeRead(settled);

    const repaired = transitionOutline(started.state, {
      type: "authoritative-repair", token: started.token, blocks: [target],
    });

    expect(findNode(repaired.state.blocks, "moved")).toBeNull();
  });
});

describe("block stamps (pkm-4ler)", () => {
  const tree = () => [
    block("u1", "one", { order_idx: 0, created_at: 100, updated_at: 200 }),
    block("u2", "two", { order_idx: 1, created_at: 100, updated_at: 200,
      children: [block("u2c", "child", { created_at: 100, updated_at: 200 })] }),
  ];
  const NOW = 9_000_000;

  it("stamps the blocks a local batch changed and leaves the rest alone", () => {
    const state = transitionOutline(createOutlineState("Page", tree()), {
      type: "local-ops", ticketId: "w1", nowMs: NOW,
      ops: [{ op: "update_text", uid: "u2c", text: "edited" }],
    }).state;

    expect(findNode(state.blocks, "u2c")?.updated_at).toBe(NOW);
    expect(findNode(state.blocks, "u1")?.updated_at).toBe(200);
    expect(findNode(state.blocks, "u2")?.updated_at).toBe(200);
  });

  it("stamps a block the batch created, so a new row shows today", () => {
    const state = transitionOutline(createOutlineState("Page", tree()), {
      type: "local-ops", ticketId: "w1", nowMs: NOW,
      ops: [{ op: "create", uid: "u3", page_title: "Page", parent_uid: null,
              order_idx: 2, text: "fresh" }],
    }).state;

    expect(findNode(state.blocks, "u3")?.updated_at).toBe(NOW);
  });

  it("does not stamp for a collapse-only batch (pkm-r7k8)", () => {
    const state = transitionOutline(createOutlineState("Page", tree()), {
      type: "local-ops", ticketId: "w1", nowMs: NOW,
      ops: [{ op: "set_collapsed", uid: "u2", collapsed: true }],
    }).state;

    expect(findNode(state.blocks, "u2")?.updated_at).toBe(200);
    expect(findNode(state.blocks, "u2")?.collapsed).toBe(true);
  });

  it("stamps remote batches exactly as local ones", () => {
    const state = transitionOutline(createOutlineState("Page", tree()), {
      type: "remote-ops", nowMs: NOW,
      ops: [{ op: "set_heading", uid: "u1", heading: 2 }],
    }).state;

    expect(findNode(state.blocks, "u1")?.updated_at).toBe(NOW);
  });

  it("ignores ops for blocks that are not on this page or were deleted", () => {
    const state = transitionOutline(createOutlineState("Page", tree()), {
      type: "remote-ops", nowMs: NOW,
      ops: [
        { op: "update_text", uid: "elsewhere", text: "other page" },
        { op: "delete", uid: "u1" },
      ],
    }).state;

    expect(findNode(state.blocks, "u1")).toBeNull();
    expect(state.blocks.map((b) => b.uid)).toEqual(["u2"]);
  });
});

describe("outline change detection (pkm-nvxh)", () => {
  const nested = () => [
    block("u1", "one", { order_idx: 0, children: [block("u1c", "child")] }),
    block("u2", "two", { order_idx: 1 }),
  ];

  it("returns the identical state for a remote op that changes nothing", () => {
    const state = createOutlineState("Page", nested());

    const result = transitionOutline(state, {
      type: "remote-ops", nowMs: 9000,
      ops: [{ op: "set_collapsed", uid: "u1", collapsed: false }],
    });

    expect(result.state).toBe(state); // React re-renders on identity
    expect(result.state.revision).toBe(0);
  });

  it("returns the identical state for a tree rebuilt with the same content", () => {
    const state = createOutlineState("Page", nested());

    const result = transitionOutline(state, {
      type: "local-tree", blocks: nested(), // equal content, fresh objects
    });

    expect(result.state).toBe(state);
  });

  it("adopts a tree whose content differs, keeping the given array", () => {
    const state = createOutlineState("Page", nested());
    const moved = [nested()[1], nested()[0]];

    const result = transitionOutline(state, {
      type: "local-tree", blocks: moved,
    });

    expect(result.state.blocks).toBe(moved);
    expect(result.state.revision).toBe(1);
  });

  it("registers a local write whose ops changed nothing, without a revision", () => {
    const state = createOutlineState("Page", nested());

    const result = transitionOutline(state, {
      type: "local-ops", ticketId: "w1", nowMs: 9000,
      ops: [{ op: "set_collapsed", uid: "u1", collapsed: false }],
    });

    expect(result.state.relevantWrites.has("w1")).toBe(true);
    expect(result.state.revision).toBe(0);
    expect(result.state.blocks).toBe(state.blocks);
  });

  it("counts the stamp as a change when a no-op text edit bumps updated_at", () => {
    // The server bumps updated_at for every update_text without comparing the
    // text (ops_apply.py's UpdateText), so the mirror here must too: the tree
    // really did change even though the op was a no-op.
    const state = createOutlineState("Page", [
      block("u1", "same", { updated_at: 2000 })]);

    const result = transitionOutline(state, {
      type: "remote-ops", nowMs: 9000,
      ops: [{ op: "update_text", uid: "u1", text: "same" }],
    });

    expect(result.state.blocks[0].updated_at).toBe(9000);
    expect(result.state.revision).toBe(1);
  });

  it("returns the identical state when even the stamp lands on the same ms", () => {
    const state = createOutlineState("Page", [
      block("u1", "same", { updated_at: 9000 })]);

    const result = transitionOutline(state, {
      type: "remote-ops", nowMs: 9000,
      ops: [{ op: "update_text", uid: "u1", text: "same" }],
    });

    expect(result.state).toBe(state);
  });

  it("keeps the existing blocks when an authoritative read matches them", () => {
    const started = beginAuthoritativeRead(createOutlineState("Page", nested()));

    const result = transitionOutline(started.state, {
      type: "authoritative", token: started.token, blocks: nested(),
    });

    expect(result.state.blocks).toBe(started.state.blocks);
    expect(result.state.revision).toBe(0);
    expect(result.state.deferredAuthoritative).toBeNull();
  });

  it("never serializes the tree to decide whether it changed", () => {
    const state = createOutlineState("Page", nested());
    const spy = vi.spyOn(JSON, "stringify");

    let next = transitionOutline(state, {
      type: "local-ops", ticketId: "w1", nowMs: 9000,
      ops: [{ op: "update_text", uid: "u1c", text: "typed" }],
    }).state;
    next = transitionOutline(next, {
      type: "remote-ops", nowMs: 9000,
      ops: [{ op: "update_text", uid: "elsewhere", text: "other page" }],
    }).state;
    next = transitionOutline(next, { type: "local-tree", blocks: nested() })
      .state;
    const serializations = spy.mock.calls.length;
    spy.mockRestore();

    expect(serializations).toBe(0);
  });

  it("passes over the previous tree at most once per op transition", () => {
    // A keystroke batch names what it changed, so applying it is the only
    // pass the previous tree needs. Counting reads of a field every walk
    // touches catches a second full-tree pass (a compare, a serialization)
    // creeping back in: the JSON.stringify compare this replaced made two.
    let reads = 0;
    const watched = watchFieldReads(nested(), () => { reads += 1; });
    const nodes = 3;
    const state = createOutlineState("Page", watched);

    transitionOutline(state, {
      type: "local-ops", ticketId: "w1", nowMs: 9000,
      ops: [{ op: "update_text", uid: "u1c", text: "typed" }],
    });

    expect(reads).toBeLessThanOrEqual(nodes);
  });
});

/** The same tree with every node's `text` behind a counting getter. Only the
 * outermost objects are instrumented: applyOps clones by spreading, so the
 * clones are plain and the count is exactly the passes over THIS tree. */
function watchFieldReads(nodes: BlockNode[], onRead: () => void): BlockNode[] {
  return nodes.map((node) => {
    const text = node.text;
    const watched: BlockNode = { ...node,
                                 children: watchFieldReads(node.children, onRead) };
    Object.defineProperty(watched, "text", {
      enumerable: true, configurable: true,
      get: () => { onRead(); return text; },
    });
    return watched;
  });
}
