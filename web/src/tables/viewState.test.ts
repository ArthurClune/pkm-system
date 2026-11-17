import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  splitMacroOptions,
} from "../grammar/macroOptions";
import { formatMacroOptions } from "../grammar/macroOptionsWrite";
import {
  initialView, isDirty, optionsFromView, stepView, viewFromOptions,
  type ViewDefaults, type ViewEvent, type ViewFields, type ViewState,
} from "./viewState";

const SAVED: ViewFields = {
  filter: "apache", sort: { col: "Published", dir: "desc" }, view: "table",
  columns: ["Author", "Published"],
};

const run = (s: ViewState, ...events: ViewEvent[]): ViewState =>
  events.reduce(stepView, s);

const edited: ViewEvent = { kind: "edited", visibleIds: ["a", "b"] };

describe("stepView", () => {
  it("starts clean, showing the saved view, with no rows held", () => {
    const s = initialView(SAVED);
    expect(s).toEqual({ saved: SAVED, live: SAVED, frozen: null });
    expect(isDirty(s)).toBe(false);
  });

  it("a filter, view or columns change edits the live view only", () => {
    const s = run(initialView(SAVED), { kind: "filter", text: "kafka" },
                  { kind: "view", view: "cards" },
                  { kind: "columns", columns: ["Format"] });
    expect(s.live).toEqual({ ...SAVED, filter: "kafka", view: "cards",
                             columns: ["Format"] });
    expect(s.saved).toEqual(SAVED);
    expect(isDirty(s)).toBe(true);
  });

  it("sortClick cycles a column through asc, desc and off", () => {
    let s = initialView({ ...SAVED, sort: null });
    s = stepView(s, { kind: "sortClick", col: "Author" });
    expect(s.live.sort).toEqual({ col: "Author", dir: "asc" });
    s = stepView(s, { kind: "sortClick", col: "Author" });
    expect(s.live.sort).toEqual({ col: "Author", dir: "desc" });
    s = stepView(s, { kind: "sortClick", col: "Author" });
    expect(s.live.sort).toBeNull();
  });

  it("sortClick on another column starts it ascending", () => {
    const s = stepView(initialView(SAVED), { kind: "sortClick", col: "Author" });
    expect(s.live.sort).toEqual({ col: "Author", dir: "asc" });
  });

  it("reset returns to the saved view and is clean", () => {
    const s = run(initialView(SAVED), { kind: "filter", text: "kafka" },
                  { kind: "sortClick", col: "Author" }, { kind: "reset" });
    expect(s.live).toEqual(SAVED);
    expect(isDirty(s)).toBe(false);
  });

  it("saved makes the live view the saved one, keeping held rows", () => {
    const s = run(initialView(SAVED), edited,
                  { kind: "filter", text: "kafka" }, edited, { kind: "saved" });
    expect(s.saved.filter).toBe("kafka");
    expect(s.frozen).toEqual(["a", "b"]);
    expect(isDirty(s)).toBe(false);
  });
});

describe("dirtiness", () => {
  it("compares filters after trimming, as the macro text stores them", () => {
    const s = stepView(initialView(SAVED), { kind: "filter", text: " apache " });
    expect(isDirty(s)).toBe(false);
  });

  it("column order matters", () => {
    const s = stepView(initialView(SAVED),
                       { kind: "columns", columns: ["Published", "Author"] });
    expect(isDirty(s)).toBe(true);
  });

  it("a sort turned off is dirty", () => {
    const s = stepView(initialView(SAVED), { kind: "sortClick", col: "Published" });
    expect(s.live.sort).toBeNull();
    expect(isDirty(s)).toBe(true);
  });

  it("a sort differing in direction only is dirty", () => {
    const s = run(initialView(SAVED), { kind: "sortClick", col: "Published" },
                  { kind: "sortClick", col: "Published" });
    expect(s.live.sort).toEqual({ col: "Published", dir: "asc" });
    expect(isDirty(s)).toBe(true);
  });

  it("typing back to the saved filter is clean again", () => {
    const s = run(initialView(SAVED), { kind: "filter", text: "apach" },
                  { kind: "filter", text: "apache" });
    expect(isDirty(s)).toBe(false);
  });
});

describe("rows held after an edit", () => {
  it("an edit holds the visible rows; a second edit keeps the first", () => {
    const s = run(initialView(SAVED), edited,
                  { kind: "edited", visibleIds: ["b"] });
    expect(s.frozen).toEqual(["a", "b"]);
  });

  it.each<[string, ViewEvent]>([
    ["filter", { kind: "filter", text: "x" }],
    ["sortClick", { kind: "sortClick", col: "Author" }],
    ["view", { kind: "view", view: "blocks" }],
    ["columns", { kind: "columns", columns: [] }],
    ["reset", { kind: "reset" }],
  ])("%s releases them", (_, event) => {
    expect(run(initialView(SAVED), edited, event).frozen).toBeNull();
  });
});

describe("release", () => {
  it("release lets held rows go and keeps the live view", () => {
    const s = run(
      initialView(SAVED), { kind: "filter", text: "kafka" }, edited,
    );
    expect(s.frozen).toEqual(["a", "b"]);
    const r = stepView(s, { kind: "release" });
    expect(r.frozen).toBeNull();
    expect(r.live).toEqual(s.live);
    expect(r.saved).toEqual(s.saved);
  });

  it("release with no rows held changes nothing", () => {
    const s = run(initialView(SAVED), { kind: "filter", text: "kafka" });
    expect(stepView(s, { kind: "release" })).toEqual(s);
  });
});

describe("loaded, a refetch of the saved view", () => {
  const remote: ViewFields = { ...SAVED, filter: "kafka", view: "cards" };

  it("a dirty live view stays as the reader left it", () => {
    const before = run(initialView(SAVED), { kind: "filter", text: "flink" },
                       edited);
    const s = stepView(before, { kind: "loaded", saved: remote });
    expect(s.saved).toEqual(remote);
    expect(s.live).toBe(before.live);
    expect(s.frozen).toEqual(["a", "b"]);
  });

  it("a clean live view follows the new saved one", () => {
    const s = run(initialView(SAVED), edited,
                  { kind: "loaded", saved: remote });
    expect(s.live).toEqual(remote);
    expect(s.frozen).toEqual(["a", "b"]);
    expect(isDirty(s)).toBe(false);
  });
});

const name = fc.stringMatching(/^[A-Za-z](?:[A-Za-z ]{0,6}[A-Za-z])?$/);
const defaultsArb: fc.Arbitrary<ViewDefaults> = fc.record({
  view: fc.constantFrom("table", "cards", "blocks"),
  columns: fc.array(name, { maxLength: 3 }),
});
const viewArb: fc.Arbitrary<ViewFields> = fc.record({
  filter: fc.oneof(fc.constant(""), name),
  sort: fc.option(fc.record({ col: name, dir: fc.constantFrom("asc", "desc") }),
                  { nil: null }),
  view: fc.constantFrom("table", "cards", "blocks"),
  columns: fc.array(name, { minLength: 1, maxLength: 3 }),
});

describe("views and macro options", () => {
  const DEFAULTS: ViewDefaults = { view: "table", columns: ["Author", "Published"] };

  it("options omit every field equal to the default", () => {
    expect(optionsFromView({ ...SAVED, filter: " ", sort: null }, DEFAULTS))
      .toEqual({});
    expect(optionsFromView({ ...SAVED, view: "cards" }, DEFAULTS))
      .toEqual({ view: "cards", filter: "apache",
                 sort: { col: "Published", dir: "desc" } });
  });

  it("a filter is saved trimmed", () => {
    expect(optionsFromView({ ...SAVED, filter: " apache ", sort: null }, DEFAULTS))
      .toEqual({ filter: "apache" });
  });

  it("missing options read as the defaults, unsorted and unfiltered", () => {
    expect(viewFromOptions({}, DEFAULTS))
      .toEqual({ filter: "", sort: null, ...DEFAULTS });
    expect(viewFromOptions({ filter: "x", sort: { col: "A", dir: "asc" } }, DEFAULTS))
      .toEqual({ ...DEFAULTS, filter: "x", sort: { col: "A", dir: "asc" } });
  });

  it("a view round-trips through its options", () => {
    fc.assert(fc.property(viewArb, defaultsArb, (v, d) => {
      expect(viewFromOptions(optionsFromView(v, d), d)).toEqual(v);
    }));
  });

  it("a view round-trips through the macro text", () => {
    fc.assert(fc.property(viewArb, defaultsArb, (v, d) => {
      const text = formatMacroOptions(optionsFromView(v, d));
      const { options } = splitMacroOptions(`table${text}`);
      expect(viewFromOptions(options, d)).toEqual(v);
    }));
  });
});
