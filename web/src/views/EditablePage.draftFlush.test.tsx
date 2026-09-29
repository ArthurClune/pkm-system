// The editor half of the composed draft-flush test. The op asserted here is
// the op server/tests/test_ops_endpoint.py posts to the ops route; the shared
// fixture binds the two halves, so a change to what a draft flush sends must
// keep both green.
import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { BlockOp } from "../api/ops";
import { sha256Hex } from "../replica/sha256";
import { ROUTER_FUTURE_FLAGS } from "../router";
import { SyncContext } from "../sync/SyncProvider";
import { block, makeSync, stubFetch } from "../test-helpers";
import { EditablePage } from "./EditablePage";

// Imported, not read with node:fs: this test needs the jsdom environment,
// where import.meta.url is not a file: URL.
import fixture from "../../../shared/fixtures/draft_flush.json";

const wireOp = {
  op: "update_text", uid: fixture.uid, text: fixture.draft,
  base_text_hash: sha256Hex(fixture.base), page_title: fixture.page_title,
};

beforeEach(() => {
  vi.useFakeTimers();
  stubFetch([["/api/titles", { titles: [] }]]);
});
afterEach(() => vi.useRealTimers());

function typeDraftUnder(remoteOps: BlockOp[]) {
  const sync = makeSync();
  render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
      <SyncContext.Provider value={sync}>
        <EditablePage title={fixture.page_title}
                      initial={[block(fixture.uid, fixture.base)]} />
      </SyncContext.Provider>
    </MemoryRouter>);
  fireEvent.click(screen.getByText(fixture.base));
  fireEvent.change(screen.getByRole("textbox"),
                   { target: { value: fixture.draft } });
  act(() => sync.emit({ client_id: "other", ts: 1, ops: remoteOps }));
  act(() => { vi.advanceTimersByTime(500); });
  return sync;
}

test("a remote update under a draft ships the fixture's wire op", () => {
  const sync = typeDraftUnder([
    { op: "update_text", uid: fixture.uid, text: fixture.remote },
  ]);
  expect(sync.sent).toEqual([[wireOp]]);
});

test("a remote delete under a draft ships the same wire op", () => {
  const sync = typeDraftUnder([{ op: "delete", uid: fixture.uid }]);
  expect(sync.sent).toEqual([[wireOp]]);
});
