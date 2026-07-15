import { describe, expect, it } from "vitest";
import type { BlockOp } from "../api/ops";
import { block } from "../test-helpers";
import {
  beginAuthoritativeRead,
  createOutlineState,
  transitionOutline,
  validateOutlineFocus,
} from "./outlineState";

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

  it("reconsiders the deferred candidate when the last relevant ticket settles", () => {
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

    expect(result.state.blocks[0].text).toBe("server");
    expect(result.state.deferredAuthoritative).toBeNull();
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
});
