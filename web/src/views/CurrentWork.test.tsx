import { act, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ROUTER_FUTURE_FLAGS } from "../router";
import { afterEach, expect, it, vi } from "vitest";
import type { CurrentWorkPayload } from "../api/payloads";
import { SyncContext } from "../sync/SyncProvider";
import { canonicalTitleOf, defer, jsonResponse, makeSync, pageIdOf, stubFetch }
  from "../test-helpers";
import { CurrentWork } from "./CurrentWork";

afterEach(() => vi.unstubAllGlobals());

it("renders changed pages grouped into exclusive current-work sections", async () => {
  stubFetch([["/api/current-work", { sections: [
    { id: "last-24-hours", heading: "Last 24 hours", pages: [
      { id: 1, title: "Recent A", updated_at: 1800000000000 },
    ] },
    { id: "24-to-48-hours", heading: "24–48 hours", pages: [
      { id: 2, title: "Yesterday", updated_at: 1799910000000 },
    ] },
    { id: "48-hours-to-7-days", heading: "48 hours–7 days", pages: [] },
  ] }]]);

  render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
      <CurrentWork />
    </MemoryRouter>,
  );

  expect(await screen.findByRole("heading", { name: "Current Work" })).toBeInTheDocument();
  const recent = screen.getByRole("region", { name: "Last 24 hours" });
  expect(within(recent).getByRole("link", { name: "Recent A" }))
    .toHaveAttribute("href", "/page/Recent%20A");
  const yesterday = screen.getByRole("region", { name: "24–48 hours" });
  expect(within(yesterday).getByRole("link", { name: "Yesterday" }))
    .toHaveAttribute("href", "/page/Yesterday");
  const older = screen.getByRole("region", { name: "48 hours–7 days" });
  expect(within(older).getByText("No pages changed in this window.")).toBeInTheDocument();
});

it("shows an error when current work cannot be loaded", async () => {
  stubFetch([]);

  render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
      <CurrentWork />
    </MemoryRouter>,
  );

  expect(await screen.findByText(/could not load current work/i)).toBeInTheDocument();
});

it("a slow first load answered after a resync's load does not overwrite it",
   async () => {
  const titled = (text: string): CurrentWorkPayload => ({ sections: [
    { id: "last-24-hours", heading: "Last 24 hours",
      pages: [{ id: pageIdOf(1), title: canonicalTitleOf(text),
                updated_at: 1800000000000 }] },
  ] });
  const first = defer<Response>();
  let calls = 0;
  vi.stubGlobal("fetch", vi.fn(() => {
    calls += 1;
    return calls === 1
      ? first.promise
      : Promise.resolve(jsonResponse(titled("After resync")));
  }));
  const sync = makeSync();
  const inSync = (s: typeof sync) => (
    <SyncContext.Provider value={s}>
      <MemoryRouter future={ROUTER_FUTURE_FLAGS}><CurrentWork /></MemoryRouter>
    </SyncContext.Provider>
  );
  const { rerender } = render(inSync(sync));
  rerender(inSync({ ...sync, resyncGeneration: 1 }));
  expect(await screen.findByRole("link", { name: "After resync" }))
    .toBeInTheDocument();

  await act(async () => { first.resolve(jsonResponse(titled("Stale"))); });
  expect(screen.queryByRole("link", { name: "Stale" })).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: "After resync" })).toBeInTheDocument();
});
