// visibleUids against the rows EditableBlockTree renders, over generated
// trees. The rendered DOM is one oracle; visibleTreeArbs' modelRows, written
// from the render rules, is the other, so neither tree.ts nor the component
// can drift alone.
import { cleanup, render } from "@testing-library/react";
import fc from "fast-check";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, test } from "vitest";
import type { BlockUid } from "../api/brands";
import type { BlockNode } from "../api/payloads";
import { EditableBlockTree } from "../components/EditableBlockTree";
import { ROUTER_FUTURE_FLAGS } from "../router";
import { uidOf } from "../test-helpers";
import type { OutlineHandlers } from "./handlers";
import { selectableUids, visibleUids } from "./tree";
import { allNodes, isMacro, isTable, modelRows, pathTo, treeArb } from "../props/outline/visibleTree";

const handlers = new Proxy({}, { get: () => () => undefined }) as OutlineHandlers;

function renderedRows(blocks: BlockNode[], focus: BlockUid | null): BlockUid[] {
  const { container } = render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
      <EditableBlockTree blocks={blocks} handlers={handlers} readOnly={false}
                         focus={focus ? { uid: focus, cursor: 0 } : null} />
    </MemoryRouter>,
  );
  const rows = [...container.querySelectorAll(".block-row")]
    .map((el) => uidOf(el.getAttribute("data-uid") ?? ""));
  cleanup();
  return rows;
}

const caseArb = fc.record({ tree: treeArb, pick: fc.nat(), focused: fc.boolean() });

describe("visibleUids", () => {
  test("is the block rows the editor renders, in order", () => {
    const tally = {
      collapsedTable: 0, collapsedPlain: 0, invalidMacro: 0, tableFocus: 0,
      hiddenFocus: 0, noFocus: 0, nested: 0, heading: 0, numbered: 0, direct: 0,
    };
    fc.assert(fc.property(caseArb, ({ tree, pick, focused }) => {
      const nodes = allNodes(tree);
      const uids = nodes.map((n) => n.uid);
      const everything = modelRows(tree, () => true);

      // The model of the all-tables-revealed view is what visibleUids gives.
      expect(visibleUids(tree)).toEqual(everything);

      // With nothing focused every table is a grid; selection steps the same.
      const none = modelRows(tree, () => false);
      expect(renderedRows(tree, null)).toEqual(none);
      expect(selectableUids(tree)).toEqual(none);

      // With focus f, the tables on f's ancestor path show their cells.
      const f = focused ? uids[pick % uids.length] : null;
      const chain = new Set(f ? pathTo(tree, f) : []);
      const expected = modelRows(tree, (uid) => chain.has(uid));
      expect(renderedRows(tree, f)).toEqual(expected);

      // The direct oracle: focus the one table there is and the render is
      // visibleUids, cell rows and all.
      const tables = nodes.filter(isTable);
      if (tables.length === 1) {
        expect(renderedRows(tree, tables[0].uid)).toEqual(visibleUids(tree));
        tally.direct += 1;
      }

      tally.noFocus += f === null ? 1 : 0;
      if (f !== null && !expected.includes(f)) tally.hiddenFocus += 1;
      if (f !== null && chain.size > 0
          && [...chain].some((u) => tables.some((t) => t.uid === u))) {
        tally.tableFocus += 1;
      }
      for (const n of nodes) {
        if (isTable(n) && n.collapsed) tally.collapsedTable += 1;
        else if (n.collapsed && n.children.length > 0) tally.collapsedPlain += 1;
        if (isMacro(n.text) && !isTable(n)) tally.invalidMacro += 1;
        if (n.heading !== null) tally.heading += 1;
        if (n.view_type === "numbered") tally.numbered += 1;
        if (n.children.some((c) => c.collapsed && c.children.length > 0)) {
          tally.nested += 1;
        }
      }
    }), { numRuns: 300 });
    for (const [name, count] of Object.entries(tally)) {
      expect(count, name).toBeGreaterThan(15);
    }
  }, 60_000);
});
