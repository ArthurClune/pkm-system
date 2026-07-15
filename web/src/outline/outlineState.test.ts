import { describe, expect, it } from "vitest";
import type { BlockOp } from "../api/ops";
import { block } from "../test-helpers";
import {
  beginAuthoritativeRead,
  createOutlineState,
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
      type: "local-ops", ticketId: "write-1", ops: [update("local")],
    }).state;
    const unrelated = transitionOutline(local, {
      type: "remote-ops", ops: [{ op: "delete", uid: "another-page" }],
    }).state;
    const remote = transitionOutline(unrelated, {
      type: "remote-ops", ops: [update("remote")],
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
      type: "local-ops", ticketId: "write-1", ops: [update("local")],
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
      type: "remote-ops", ops: [update("remote")],
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
      { type: "local-ops", ticketId: "write-1", ops: [update("local")] },
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
      scope: ["page", "Page B"],
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
      type: "local-ops", ticketId: "write-1", ops: [update("local")],
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
      type: "local-ops", ticketId: "rejected",
      ops: [{ op: "update_text", uid: "u2", text: "rejected local" }],
    }).state;
    const later = transitionOutline(rejected, {
      type: "local-ops", ticketId: "later",
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
    } as Parameters<typeof transitionOutline>[1]);

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
      type: "remote-ops", ops: [update("remote advance")],
    }).state;

    const stale = transitionOutline(advanced, {
      type: "authoritative-repair", token: started.token,
      blocks: [block("u1", "stale repair")],
    } as Parameters<typeof transitionOutline>[1]);

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
    } as Parameters<typeof transitionOutline>[1]).state;
    const childEdit = transitionOutline(moveTracked, {
      type: "local-ops", ticketId: "edit",
      ops: [{ op: "update_text", uid: "child", text: "later child edit" }],
    }).state;
    const started = beginAuthoritativeRead(childEdit);

    const repaired = transitionOutline(started.state, {
      type: "authoritative-repair", token: started.token,
      blocks: [targetParent],
    } as Parameters<typeof transitionOutline>[1]);

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
      } as Parameters<typeof transitionOutline>[1],
    ).state;
    const started = beginAuthoritativeRead(tracked);

    const repaired = transitionOutline(started.state, {
      type: "authoritative-repair", token: started.token,
      blocks: [moved, target],
    } as Parameters<typeof transitionOutline>[1]);

    expect(repaired.state.blocks.map((node) => node.uid)).toEqual(["target"]);
    expect(repaired.state.blocks[0].children.map((node) => node.uid))
      .toEqual(["moved"]);
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
      } as Parameters<typeof transitionOutline>[1],
    ).state;
    const settled = transitionOutline(tracked, {
      type: "write-settled", ticketId: "terminal-move",
    }).state;
    const started = beginAuthoritativeRead(settled);

    const repaired = transitionOutline(started.state, {
      type: "authoritative-repair", token: started.token, blocks: [target],
    } as Parameters<typeof transitionOutline>[1]);

    expect(findNode(repaired.state.blocks, "moved")).toBeNull();
  });
});
