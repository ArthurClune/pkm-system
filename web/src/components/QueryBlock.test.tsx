import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { stubFetch } from "../test-helpers";
import { tokenizeBlock } from "../grammar/tokenize";
import { InlineSegments } from "./InlineSegments";
import { QueryBlock } from "./QueryBlock";

afterEach(() => vi.unstubAllGlobals());

const EXPR = "{and: [[Generative Models]] [[Link]]}";
const ENC = encodeURIComponent(EXPR);

it("evaluates on mount, groups by page, shows the total, paginates", async () => {
  const fetchMock = stubFetch([
    [`/api/query?expr=${ENC}&limit=20&offset=1`, {
      groups: [{ page_id: 7, page_title: "July 1st, 2026", items: [
        { uid: "uid_q2", text: "second [[Link]]" }] }],
      total: 2,
    }],
    [`/api/query?expr=${ENC}`, {
      groups: [{ page_id: 6, page_title: "Generative Models", items: [
        { uid: "uid_q1", text: "a [[Link]] here" }] }],
      total: 2,
    }],
  ]);
  render(<MemoryRouter><QueryBlock expr={EXPR} /></MemoryRouter>);
  expect(await screen.findByRole("link", { name: "Generative Models" })).toBeInTheDocument();
  expect(screen.getByText("2 results")).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledWith(
    `/api/query?expr=${ENC}&limit=20&offset=0`, undefined);
  fireEvent.click(screen.getByRole("button", { name: /show more/i }));
  expect(await screen.findByRole("link", { name: "July 1st, 2026" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /show more/i })).toBeNull();
});

it("InlineSegments renders query segments as live QueryBlocks", async () => {
  stubFetch([[`/api/query?expr=${ENC}`, { groups: [], total: 0 }]]);
  render(
    <MemoryRouter>
      <InlineSegments segments={tokenizeBlock(`{{[[query]]: ${EXPR}}}`)} />
    </MemoryRouter>,
  );
  expect(await screen.findByText("0 results")).toBeInTheDocument();
  expect(screen.getByText(`query: ${EXPR}`)).toBeInTheDocument();
});

it("shows the server's 400 as an error state", async () => {
  vi.stubGlobal("fetch", vi.fn(async () =>
    new Response(JSON.stringify({ detail: "bad query" }), { status: 400 })));
  render(<MemoryRouter><QueryBlock expr="{nonsense" /></MemoryRouter>);
  expect(await screen.findByText(/400/)).toBeInTheDocument();
});
