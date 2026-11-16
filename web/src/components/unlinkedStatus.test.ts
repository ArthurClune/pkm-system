import { describe, expect, it } from "vitest";
import type { BlockGroup } from "../api/payloads";
import { canonicalTitleOf, pageIdOf, uidOf } from "../test-helpers";
import {
  canLink, isListed, nextOffset, queuedCount, withStatus, withoutDelivered,
  type LinkStatus, type LinkStatuses,
} from "./unlinkedStatus";

const A = uidOf("tuid-a");
const B = uidOf("tuid-b");
const C = uidOf("tuid-c");
const none: LinkStatuses = new Map();
const at = (status: LinkStatus): LinkStatuses => new Map([[A, status]]);
const failed = { error: "boom" } as const;

describe("unlinkedStatus", () => {
  // Every status a block can be in, against every status it could be asked
  // to move to. "same" means the move is refused: the map comes back as is.
  type From = "none" | "pending" | "queued" | "delivered" | "error";
  const from: Record<From, LinkStatuses> = {
    none, pending: at("pending"), queued: at("queued"),
    delivered: at("delivered"), error: at(failed),
  };
  const table: [From, LinkStatus, "moves" | "same"][] = [
    ["none", "pending", "moves"],
    ["none", { error: "no match" }, "moves"],
    ["none", "queued", "same"],
    ["none", "delivered", "same"],
    ["error", "pending", "moves"],
    ["error", { error: "again" }, "moves"],
    ["error", { error: "boom" }, "same"],
    ["error", "queued", "same"],
    ["pending", "queued", "moves"],
    ["pending", { error: "queue" }, "moves"],
    ["pending", "pending", "same"],
    ["pending", "delivered", "same"],
    ["queued", "delivered", "moves"],
    ["queued", { error: "delivery" }, "moves"],
    ["queued", "pending", "same"],
    ["delivered", "pending", "same"],
    ["delivered", { error: "late" }, "same"],
    ["delivered", "queued", "same"],
  ];
  it.each(table)("from %s to %j: %s", (start, status, outcome) => {
    const before = from[start];
    const after = withStatus(before, A, status);
    if (outcome === "same") expect(after).toBe(before);
    else expect(after.get(A)).toEqual(status);
  });

  it("only a block with no status or an error can be linked", () => {
    expect(canLink(undefined)).toBe(true);
    expect(canLink(failed)).toBe(true);
    expect(canLink("pending")).toBe(false);
    expect(canLink("queued")).toBe(false);
    expect(canLink("delivered")).toBe(false);
  });

  it("a queued or delivered block is not listed", () => {
    expect(isListed(undefined)).toBe(true);
    expect(isListed("pending")).toBe(true);
    expect(isListed(failed)).toBe(true);
    expect(isListed("queued")).toBe(false);
    expect(isListed("delivered")).toBe(false);
  });

  it("moving one block leaves the others", () => {
    const two = withStatus(withStatus(none, A, "pending"), B, "pending");
    const after = withStatus(two, A, "queued");
    expect(after.get(B)).toBe("pending");
    expect(two.get(A)).toBe("pending");
  });

  it("a fetched batch drops delivered blocks and keeps queued ones", () => {
    const statuses = new Map<typeof A, LinkStatus>(
      [[A, "delivered"], [B, "queued"]]);
    const groups: BlockGroup[] = [{
      page_id: pageIdOf(1), page_title: canonicalTitleOf("Src"),
      items: [A, B, C].map((uid) => ({ uid, text: "Acme" })),
    }];
    expect(withoutDelivered(groups, statuses)[0]?.items.map((i) => i.uid))
      .toEqual([B, C]);
  });

  it("the next offset counts queued blocks out and delivered ones not at " +
     "all", () => {
    const statuses = new Map<typeof A, LinkStatus>(
      [[A, "delivered"], [B, "queued"], [C, "pending"]]);
    expect(queuedCount(statuses)).toBe(1);
    expect(nextOffset(20, statuses)).toBe(19);
    expect(nextOffset(20, none)).toBe(20);
  });
});
