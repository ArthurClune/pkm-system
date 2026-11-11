import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import type { BlockGroup } from "../api/payloads";
import type { DeliveryOutcome, WriteOutcome, WriteTicket } from "../sync/opQueue";
import { SyncContext, type Sync } from "../sync/SyncProvider";
import {
  canonicalTitleOf, defer, jsonResponse, makeSync, pageIdOf, ticketIdOf,
  uidOf,
} from "../test-helpers";
import { UnlinkedSection } from "./UnlinkedSection";

afterEach(() => vi.unstubAllGlobals());

const ACME = canonicalTitleOf("ACME");
const item = (n: number) =>
  ({ uid: uidOf(`uid_u${n}`), text: `Acme mention ${n}` });
const listing = (ns: number[], total: number) => ({
  groups: [{ page_id: pageIdOf(2), page_title: canonicalTitleOf("Source"),
             items: ns.map(item) }] satisfies BlockGroup[],
  total,
});

/** A sync whose tickets settle and deliver when the test says. */
function controlledSync() {
  const sync = makeSync();
  const settled = defer<WriteOutcome>();
  const delivered = defer<DeliveryOutcome>();
  sync.enqueue = vi.fn<Sync["enqueue"]>((ops, scope) => {
    sync.sent.push(ops);
    const ticket = {
      id: ticketIdOf(`controlled-write-${sync.tickets.length + 1}`),
      scope: scope ?? [], settled: settled.promise,
      delivered: delivered.promise,
    } satisfies WriteTicket;
    sync.tickets.push(ticket);
    return ticket;
  });
  return { sync, settled, delivered };
}

function renderSection(sync: Sync) {
  render(
    <SyncContext.Provider value={sync}>
      <MemoryRouter>
        <UnlinkedSection title={ACME} />
      </MemoryRouter>
    </SyncContext.Provider>,
  );
  fireEvent.click(screen.getByText(/unlinked references/i));
}

it("two Link clicks before a re-render enqueue once", async () => {
  vi.stubGlobal("fetch", vi.fn(() =>
    Promise.resolve(jsonResponse(listing([1, 2], 2)))));
  const { sync } = controlledSync();
  renderSection(sync);
  const [first] = await screen.findAllByRole("button", { name: "Link" });

  act(() => {
    first!.click();
    first!.click();
  });

  expect(sync.enqueue).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("button", { name: "Linking…" })).toBeDisabled();
});

it("a batch answered before a link was delivered neither brings the block " +
   "back nor shifts the next offset", async () => {
  // The server lists blocks 1 to 3 until block 1's link is delivered, then
  // 2 and 3. The offset-1 batch is answered from the old list, late.
  const late = defer<Response>();
  let delivered = false;
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const offset = Number(
      new URL(String(input), "http://x").searchParams.get("offset"));
    if (offset === 1 && !delivered) return late.promise;
    const listed = delivered ? [2, 3] : [1, 2, 3];
    return Promise.resolve(
      jsonResponse(listing(listed.slice(offset, offset + 1), listed.length)));
  });
  vi.stubGlobal("fetch", fetchMock);
  const ticket = controlledSync();
  renderSection(ticket.sync);
  fireEvent.click(await screen.findByRole("button", { name: "Show more" }));
  fireEvent.click(screen.getByRole("button", { name: "Link" }));
  await act(async () => {
    ticket.settled.resolve({ status: "persisted", pending: 1 });
    await ticket.settled.promise;
  });
  delivered = true;
  await act(async () => {
    ticket.delivered.resolve({ status: "delivered" });
    await ticket.delivered.promise;
  });
  expect(screen.queryByText("Acme mention 1")).toBeNull();

  await act(async () => {
    late.resolve(jsonResponse(listing([1, 2], 3)));
    await late.promise;
  });
  expect(await screen.findByText("Acme mention 2")).toBeInTheDocument();
  expect(screen.queryByText("Acme mention 1")).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Show more" }));
  expect(await screen.findByText("Acme mention 3")).toBeInTheDocument();
  expect(String(fetchMock.mock.calls.at(-1)?.[0])).toContain("offset=1");
});
