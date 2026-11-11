// pattern: Functional Core
// The banner model, from sync-recovery.md § What the UI shows, § The recovery
// barrier and § A batch the server rejects, never from syncState.ts: which
// problem one page load's session shows, given the events it has folded and
// whether the queue holds a claim only the replica can release.
//   poison    a rejected batch's latest phase (mark failed, repair running,
//             failed or repaired) or a discovery that could not answer; a
//             discard ends a failed mark, a cleared discovery ends itself
//   ranking   without the replica gone, the poison problem is shown, else a
//             stalled replica's banner, else none
//   gone      once a no-replica report has come, a failed mark and a repaired
//             batch are kept (their action needs no worker); anything else,
//             nothing included, shows the online-only banner, so it comes
//             back when a kept problem ends
//   paused    the online-only banner carries paused exactly while the queue
//             holds a poison or startup claim
// What the docs leave to the code is not modelled: an outline repair, a
// reset, a dismiss, and a stall report in a life that also has a poison
// problem while the replica is still there. A life with any of those is
// reported unmodelled, with the reason, for the tally.
import type { SyncEvent, SyncProblem } from "../../sync/syncState";

/** A problem as the banner rule sees it: its kind, the repair phase of a
 * rejected batch, and the online-only banner's paused flag. */
export type BannerView = string;

/** The view, and the rules that decided it, for the tally. */
export type BannerExpectation =
  | { view: BannerView; rules: string[] }
  | { unmodelled: string };

type Poison = "mark-failed" | "running" | "failed" | "repaired" | "discovery";

const POISON_VIEW: Record<Poison, BannerView> = {
  "mark-failed": "rejected-batch mark-failed",
  running: "rejected-batch running",
  failed: "rejected-batch failed",
  repaired: "rejected-batch repaired",
  discovery: "poison-discovery",
};

export function viewOf(problem: SyncProblem | undefined): BannerView {
  if (problem === undefined) return "none";
  switch (problem.kind) {
    case "rejected-batch": return `rejected-batch ${problem.repair}`;
    case "outline-rejected": return `outline-rejected ${problem.repair}`;
    case "replica-unusable":
      return problem.paused === true ? "replica-unusable paused" : "replica-unusable";
    case "replica-stalled":
    case "poison-discovery":
      return problem.kind;
  }
}

const POISON_EVENTS = new Set<SyncEvent["type"]>([
  "poison-mark-failed", "repair-started", "repair-failed", "repair-succeeded",
  "poison-discovery-failed", "poison-intents-discarded",
  "poison-discovery-cleared",
]);

const UNMODELLED = new Set<SyncEvent["type"]>([
  "outline-repair-started", "outline-repair-succeeded", "outline-repair-failed",
  "reset-started", "reset-blocked", "reset-failed", "reset-succeeded", "dismiss",
]);

/** Whether a poison repair has started among `events` and not yet ended. */
export function repairRunning(events: readonly SyncEvent[]): boolean {
  let running = false;
  for (const e of events) {
    if (e.type === "repair-started") running = true;
    else if (e.type === "repair-succeeded" || e.type === "repair-failed") running = false;
  }
  return running;
}

/** What the banner must show after `events`, one page load's in fold
 * order; `held` is whether the queue holds poison or startup right now. */
export function expectedBanner(events: readonly SyncEvent[],
                               held: boolean): BannerExpectation {
  let poison: Poison | null = null;
  let gone = false;
  let stalled = false;
  let stallReported = false;
  /** What the no-replica report found shown, and what came after it. */
  const rules: string[] = [];
  for (const e of events) {
    if (UNMODELLED.has(e.type)) return { unmodelled: e.type };
    const before: Poison | null = poison;
    const kept = gone && (poison === "mark-failed" || poison === "repaired");
    switch (e.type) {
      case "replica-state": {
        const mode = e.state.mode;
        if (mode === "no-replica") {
          if (!gone) {
            rules.push(poison !== null ? `gone over ${poison}`
              : stalled ? "gone over stalled" : "gone over none");
          }
          gone = true;
        } else if (mode === "ready") stalled = false;
        else if (mode === "stalled" ||
                 (mode === "recovery-failed" && e.status === "connected")) {
          stalled = true;
          stallReported = true;
        }
        break;
      }
      case "poison-mark-failed": poison = "mark-failed"; break;
      case "repair-started": poison = "running"; break;
      case "repair-failed": poison = "failed"; break;
      case "repair-succeeded": poison = "repaired"; break;
      case "poison-discovery-failed": poison = "discovery"; break;
      case "poison-intents-discarded":
        if (poison === "mark-failed") poison = null;
        break;
      case "poison-discovery-cleared":
        if (poison === "discovery") poison = null;
        break;
      default: break;
    }
    if (kept && poison !== "mark-failed" && poison !== "repaired") {
      rules.push(`gone, a kept problem ended by ${e.type}`);
    } else if (gone && poison !== null && poison !== before) {
      rules.push(`gone, then ${poison}`);
    }
  }
  if (gone) {
    if (poison === "mark-failed" || poison === "repaired") {
      return { view: POISON_VIEW[poison], rules };
    }
    return { view: held ? "replica-unusable paused" : "replica-unusable", rules };
  }
  if (stallReported && events.some((e) => POISON_EVENTS.has(e.type))) {
    return { unmodelled: "a stall report beside a poison problem" };
  }
  if (poison !== null) return { view: POISON_VIEW[poison], rules };
  return { view: stalled ? "replica-stalled" : "none", rules };
}
