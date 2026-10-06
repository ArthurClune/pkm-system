import { describe, expect, test } from "vitest";
import { classify, emptyTally, renderArg, summarise, type WarnArgs } from "./warnings";

const engine = (code: number, name: string): WarnArgs =>
  ["sqlite3_step() rc=", code, name, "SQL =", "INSERT INTO blocks"];

describe("classify", () => {
  test("tallies engine constraint failures by result name", () => {
    let t = emptyTally();
    t = classify(t, engine(1555, "SQLITE_CONSTRAINT_PRIMARYKEY"), "x");
    t = classify(t, engine(1555, "SQLITE_CONSTRAINT_PRIMARYKEY"), "x");
    t = classify(t, engine(787, "SQLITE_CONSTRAINT_FOREIGNKEY"), "x");
    expect([...t.counts]).toEqual([
      ["engine SQLITE_CONSTRAINT_PRIMARYKEY", 2],
      ["engine SQLITE_CONSTRAINT_FOREIGNKEY", 1],
    ]);
    expect(t.unknown).toEqual([]);
  });

  test("an engine failure that is not a constraint is unknown", () => {
    const t = classify(emptyTally(), engine(11, "SQLITE_CORRUPT"), "ctx");
    expect(t.counts.size).toBe(0);
    expect(t.unknown).toHaveLength(1);
  });

  test("tallies both rebootstrap logs", () => {
    let t = emptyTally();
    t = classify(t, ["applyChanges: stale title holder, rebootstrapping", new Error("e")], "x");
    t = classify(t, ["applyChanges: window failed its deferred FK check, rebootstrapping", "e"], "x");
    expect([...t.counts]).toEqual([["stale-title rebootstraps", 1], ["deferred-FK rebootstraps", 1]]);
  });

  test("keeps unknown calls with their context", () => {
    const t = classify(emptyTally(), ["probe:", { a: 1 }], "suite > test seed=7");
    expect(t.unknown).toEqual([{ context: "suite > test seed=7", text: 'probe: {"a":1}' }]);
  });

  test("a non-string first argument is unknown", () => {
    expect(classify(emptyTally(), [42], "c").unknown).toHaveLength(1);
    expect(classify(emptyTally(), [], "c").unknown).toHaveLength(1);
  });

  test("an engine line with a non-string name falls back to the code", () => {
    const t = classify(emptyTally(), ["sqlite3_step() rc=", 1555], "c");
    expect([...t.counts]).toEqual([["engine 1555", 1]]);
  });
});

describe("summarise", () => {
  test("zero warnings", () => {
    expect(summarise("ops", emptyTally())).toBe("fault warnings (ops): none");
  });

  test("one line of counts", () => {
    let t = emptyTally();
    t = classify(t, engine(1555, "SQLITE_CONSTRAINT_PRIMARYKEY"), "x");
    t = classify(t, ["applyChanges: stale title holder, rebootstrapping"], "x");
    expect(summarise("sync", t)).toBe(
      "fault warnings (sync): 1 engine SQLITE_CONSTRAINT_PRIMARYKEY, 1 stale-title rebootstraps");
  });

  test("lists unknown calls verbatim after the counts", () => {
    const t = classify(emptyTally(), ["probe: unexpected"], "ops > a test");
    expect(summarise("ops", t)).toBe(
      "fault warnings (ops): none\n  1 unexpected:\n  UNEXPECTED [ops > a test] probe: unexpected");
  });
});

describe("renderArg", () => {
  test("renders strings, errors, undefined, objects and cycles", () => {
    expect(renderArg("s")).toBe("s");
    expect(renderArg(new TypeError("bad"))).toBe("TypeError: bad");
    expect(renderArg(undefined)).toBe("undefined");
    expect(renderArg({ a: 1 })).toBe('{"a":1}');
    const cyc: Record<string, unknown> = {};
    cyc.self = cyc;
    expect(renderArg(cyc)).toBe("[object Object]");
    expect(renderArg(() => 1)).toBe("() => 1");
  });
});
