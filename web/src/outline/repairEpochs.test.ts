import { expect, it, vi } from "vitest";
import { defer } from "../test-helpers";
import {
  activeRepairCompletion,
  isRepairActive,
  runRepair,
  type RepairCohort,
  type RepairTarget,
} from "./repairEpochs";

/** A session as the epoch sees it. `state` is the identity the epoch compares
 * between passes; a test moves it to simulate a remote batch landing while
 * the target's own read was in flight. */
function createTarget(name: string) {
  const control = {
    state: { name, at: 0 },
    active: true,
    reads: 0,
    settles: 0,
    /** Each read's response: adopt (default), skip, or fail. */
    respond: (): Promise<unknown> => Promise.resolve(control.state),
    move: () => { control.state = { name, at: control.state.at + 1 }; },
  };
  const target: RepairTarget = {
    currentState: () => control.state,
    isActive: () => control.active,
    settle: () => { control.settles += 1; },
    repairRead: () => {
      control.reads += 1;
      return control.respond();
    },
  };
  return { control, target };
}

function createCohort(...targets: RepairTarget[]) {
  const registry = [...targets];
  const ended = vi.fn();
  const cohort: RepairCohort = {
    targets: () => registry,
    epochEnded: ended,
  };
  return { cohort, registry, ended };
}

it("repairs every live target once and settles when nothing moved", async () => {
  const first = createTarget("first");
  const second = createTarget("second");
  const { cohort, ended } = createCohort(first.target, second.target);
  const onStable = vi.fn();

  expect(isRepairActive()).toBe(false);
  const repairing = runRepair(cohort, onStable);
  expect(isRepairActive()).toBe(true);
  await repairing;

  expect(first.control.reads).toBe(1);
  expect(second.control.reads).toBe(1);
  expect(first.control.settles).toBe(1);
  expect(onStable).toHaveBeenCalledTimes(1);
  expect(ended).toHaveBeenCalledTimes(1);
  expect(isRepairActive()).toBe(false);
  expect(activeRepairCompletion()).toBeNull();
});

it("skips targets no handle holds any more", async () => {
  const live = createTarget("live");
  const gone = createTarget("gone");
  gone.control.active = false;
  const { cohort } = createCohort(live.target, gone.target);

  await runRepair(cohort);

  expect(live.control.reads).toBe(1);
  expect(gone.control.reads).toBe(0);
});

it("repairs again a target whose state moved during its own read", async () => {
  const target = createTarget("moving");
  const { cohort } = createCohort(target.target);
  target.control.respond = () => {
    // A remote batch lands while the first read is in flight: that response
    // is rejected (null) and the state the epoch compares has advanced. The
    // second read finds a quiet session and is adopted.
    if (target.control.reads > 1) return Promise.resolve(target.control.state);
    target.control.move();
    return Promise.resolve(null);
  };

  const repairing = runRepair(cohort);
  await repairing;

  expect(target.control.reads).toBe(2);
  expect(target.control.settles).toBe(2);
});

it("enrols a target that appears mid-epoch", async () => {
  const first = createTarget("first");
  const late = createTarget("late");
  const { cohort, registry } = createCohort(first.target);
  const response = defer<unknown>();
  first.control.respond = () => response.promise;

  const repairing = runRepair(cohort);
  await vi.waitFor(() => expect(first.control.reads).toBe(1));
  registry.push(late.target);
  response.resolve(first.control.state);
  await repairing;

  expect(late.control.reads).toBe(1);
});

it("runs one read per target while an epoch pass is in flight", async () => {
  const target = createTarget("in-flight");
  const { cohort, registry } = createCohort(target.target);
  const response = defer<unknown>();
  target.control.respond = () => response.promise;

  const repairing = runRepair(cohort);
  await vi.waitFor(() => expect(target.control.reads).toBe(1));
  // A second registration of the same target cannot double-read it.
  registry.push(target.target);
  await Promise.resolve();
  expect(target.control.reads).toBe(1);

  response.resolve(target.control.state);
  await repairing;
  expect(target.control.reads).toBe(1);
});

it("joins the running epoch and adds a later onStable to it", async () => {
  const target = createTarget("shared");
  const { cohort } = createCohort(target.target);
  const response = defer<unknown>();
  target.control.respond = () => response.promise;
  const first = vi.fn();
  const second = vi.fn();

  const repairing = runRepair(cohort, first);
  const joined = runRepair(createCohort(createTarget("ignored").target).cohort,
                           second);
  expect(joined).toBe(repairing);
  expect(activeRepairCompletion()).toBe(repairing);

  response.resolve(target.control.state);
  await repairing;
  expect(first).toHaveBeenCalledTimes(1);
  expect(second).toHaveBeenCalledTimes(1);
  expect(target.control.reads).toBe(1);
});

it("clears the epoch when a target cannot be repaired at all", async () => {
  const target = createTarget("no loader");
  const { cohort, ended } = createCohort(target.target);
  target.control.respond = () =>
    Promise.reject(new Error("No authoritative loader"));
  const onStable = vi.fn();

  await expect(runRepair(cohort, onStable)).rejects.toThrow(
    /No authoritative loader/,
  );

  expect(onStable).not.toHaveBeenCalled();
  expect(ended).toHaveBeenCalledTimes(1);
  expect(target.control.settles).toBe(1);
  expect(isRepairActive()).toBe(false);
  expect(activeRepairCompletion()).toBeNull();
});
