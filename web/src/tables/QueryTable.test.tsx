import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, useLocation } from "react-router";
import { expect, it, vi } from "vitest";
import type { QueryRecordModel, RecordCell } from "../api/payloads";
import { pagePath } from "../paths";
import { canonicalTitleOf, pageIdOf, uidOf } from "../test-helpers";
import { QueryCards } from "./QueryCards";
import { QueryTable } from "./QueryTable";
import type { QueryColumn, ShownRow } from "./queryView";

const PAGE = canonicalTitleOf("Paper/Measuring Garden Growth");
const PDF = `[paper.pdf](/assets/${"ab".repeat(32)}/paper.pdf)`;
const MERMAID = "```mermaid\ngraph TD; A-->B\n```";

function cell(raw: string, key: string, value: string): RecordCell {
  const text = `${key}:: ${value}`;
  return { uid: uidOf(raw), key_raw: key, text, value,
           value_start: key.length + 3 };
}

const RECORD: QueryRecordModel = {
  key: "p:1", kind: "page", page_id: pageIdOf(1), page_title: PAGE,
  uid: null, row_title: "Measuring Garden Growth",
  result_uids: [uidOf("tuid-r1")], insert_parent_uid: null,
  insert_before_order_idx: null, last_attr_order_idx: null,
  cells: {
    "local copy": cell("tuid-pdf", "Local copy", PDF),
    diagram: cell("tuid-mer", "Diagram", MERMAID),
  },
};

const COLUMNS: QueryColumn[] = [
  { name: "Local copy", label: "Local copy", key: "local copy" },
  { name: "Diagram", label: "Diagram", key: "diagram" },
];
const ROWS: ShownRow[] = [{ record: RECORD, row: {}, stale: false }];

function LocProbe() {
  const loc = useLocation();
  return <p data-testid="loc">{loc.pathname + loc.hash}</p>;
}

function mount(view: ReactNode) {
  return render(
    <MemoryRouter initialEntries={["/page/Reading%20List"]}>
      {view}
      <LocProbe />
    </MemoryRouter>,
  );
}

const table = () => (
  <QueryTable rows={ROWS} columns={COLUMNS} keys={[]} records={[RECORD]}
              sort={null} onSortClick={vi.fn()} canEdit onWrite={vi.fn()}
              onColumns={vi.fn()} depth={0} />
);
const cards = () => <QueryCards rows={ROWS} columns={COLUMNS} depth={0} />;

it.each([["table", table], ["cards", cards]])(
  "a %s cell shows a PDF as a label", (_name, view) => {
    const { container } = mount(view());
    expect(screen.getByRole("button", {
      name: "Open PDF full screen: paper.pdf",
    })).toHaveTextContent("📄 paper.pdf");
    expect(container.querySelector(".pdf-embed")).toBeNull();
  });

it.each([["table", table], ["cards", cards]])(
  "a %s cell's line label goes to the cell on its page", (_name, view) => {
    mount(view());
    fireEvent.click(screen.getByRole("button", { name: "↗ Mermaid diagram" }));
    expect(screen.getByTestId("loc"))
      .toHaveTextContent(`${pagePath(PAGE)}#tuid-mer`);
    expect(document.querySelector("textarea")).toBeNull();
  });
