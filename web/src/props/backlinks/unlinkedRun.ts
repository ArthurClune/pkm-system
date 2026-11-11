// pattern: Functional Core
// Runs one drawn example of status moves through the Unlinked references
// lifecycle functions beside the model (unlinkedModel.ts) and checks every
// step. Stops at the first step with a problem and returns every problem
// found there, each led by the invariant it breaks.
import type { BlockUid } from "../../api/brands";
import type { BlockGroup } from "../../api/payloads";
import {
  canLink, isListed, nextOffset, settledCount, withoutDelivered, withStatus,
  type LinkStatus, type LinkStatuses,
} from "../../components/unlinkedStatus";
import { canonicalTitleOf, pageIdOf, uidOf } from "../../test-mint";
import { BLOCKS, type Example, type Target } from "./unlinkedArbitraries";
import { linkable, listed, moved, allowed, type ModelStatus } from "./unlinkedModel";

export interface UnlinkedOps {
  readonly withStatus: typeof withStatus;
  readonly canLink: typeof canLink;
  readonly isListed: typeof isListed;
  readonly settledCount: typeof settledCount;
  readonly nextOffset: typeof nextOffset;
  readonly withoutDelivered: typeof withoutDelivered;
}

export const REAL_OPS: UnlinkedOps = {
  withStatus, canLink, isListed, settledCount, nextOffset, withoutDelivered,
};

export interface RunResult {
  readonly problems: readonly string[];
  readonly reached: ReadonlySet<string>;
  readonly at: number;
}

const uids: readonly BlockUid[] = Array.from({ length: BLOCKS }, (_, i) => uidOf(`tuid-${i}`));

/** Two pages' worth of blocks, two to a page. */
const groups: BlockGroup[] = [0, 1].map((p) => ({
  page_id: pageIdOf(p + 1), page_title: canonicalTitleOf(`P${p}`),
  items: [2 * p, 2 * p + 1].map((i) => ({ uid: uids[i], text: `t${i}` })),
}));

function status(target: Target): LinkStatus {
  return target === "error a" ? { error: "a" } : target === "error b" ? { error: "b" } : target;
}

function modelOf(s: LinkStatus | undefined): ModelStatus {
  if (s === undefined) return "none";
  if (typeof s === "object") return s.error === "a" ? "error a" : "error b";
  return s;
}

export function runExample(example: Example, ops: UnlinkedOps = REAL_OPS): RunResult {
  const reached = new Set<string>();
  let statuses: LinkStatuses = new Map();
  let model: ModelStatus[] = Array.from({ length: BLOCKS }, () => "none");

  for (const [i, step] of example.steps.entries()) {
    const problems: string[] = [];
    const before = statuses;
    const beforeEntries = JSON.stringify([...before]);
    const from = model[step.block];
    const to = step.to as ModelStatus;
    statuses = ops.withStatus(statuses, uids[step.block], status(step.to));
    model = model.map((s, at) => at === step.block ? moved(from, to) : s);

    if (JSON.stringify([...before]) !== beforeEntries) {
      problems.push("pure: the map passed in was changed");
    }
    const ok = allowed(from, to) && from !== to;
    if (ok) {
      reached.add(`${from} to ${to.startsWith("error") ? "error" : to}`);
      if (to.startsWith("error") && from === "settled") reached.add("delivery fails after settle");
      if (from === "error a" || from === "error b") {
        if (to === "pending") reached.add("error retried");
        else reached.add("error message replaced");
      }
    } else {
      if (statuses !== before) {
        problems.push(`same-map: ${from} to ${to}, refused or repeated, returned a new map`);
      }
      if (from === "delivered") reached.add("delivered stays delivered");
      else if (from === to) reached.add("move repeated");
      else reached.add("move refused");
    }

    uids.forEach((uid, at) => {
      const got = modelOf(statuses.get(uid));
      if (got !== model[at]) problems.push(`lifecycle: block ${at} is ${got}, model ${model[at]}`);
      if (ops.canLink(statuses.get(uid)) !== linkable(model[at])) {
        problems.push(`can-link: block ${at} (${model[at]})`);
      }
      if (ops.isListed(statuses.get(uid)) !== listed(model[at])) {
        problems.push(`listed: block ${at} (${model[at]})`);
      }
    });
    const settled = model.filter((s) => s === "settled").length;
    if (ops.settledCount(statuses) !== settled) {
      problems.push(`settled-count: ${ops.settledCount(statuses)}, model ${settled}`);
    }
    if (ops.nextOffset(example.loaded, statuses) !== example.loaded - settled) {
      problems.push(`next-offset: ${ops.nextOffset(example.loaded, statuses)}, model ${example.loaded - settled}`);
    }
    const kept = ops.withoutDelivered(groups, statuses).flatMap((g) => g.items.map((x) => x.uid));
    const wantKept = uids.filter((_, at) => model[at] !== "delivered");
    if (kept.join() !== wantKept.join()) {
      problems.push(`delivered-hidden: kept ${kept.length} blocks, model ${wantKept.length}`);
    }
    if (model.includes("delivered") && model.includes("settled")) reached.add("delivered beside settled");

    if (problems.length > 0) {
      return { problems: problems.map((p) => `${p} (step ${i})`), reached, at: i };
    }
  }
  return { problems: [], reached, at: example.steps.length };
}
