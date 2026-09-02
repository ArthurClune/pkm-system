import { act, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, expect, test, vi } from "vitest";
import { ROUTER_FUTURE_FLAGS } from "../router";
import { block, FakeWebSocket, stubFetch } from "../test-helpers";
import * as tokenize from "../grammar/tokenize";
import { SyncProvider, useSyncActions,
         type SyncActions } from "../sync/SyncProvider";
import { EditablePage } from "./EditablePage";

// The end-to-end version of the split: a real SyncProvider, a real outline,
// and a count of the rows that re-rendered. Journal mounts one of these per
// loaded day and never unmounts it, so the cost of one stray context identity
// is multiplied by the number of days on screen (pkm-qfee).
vi.mock("../grammar/tokenize", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../grammar/tokenize")>();
  return { ...actual, tokenizeBlock: vi.fn(actual.tokenizeBlock) };
});

const lastWs = (): FakeWebSocket =>
  FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
const tokenizeCalls = () => vi.mocked(tokenize.tokenizeBlock).mock.calls.length;

let actions!: SyncActions;
function Grab() {
  actions = useSyncActions();
  return null;
}

beforeEach(() => {
  localStorage.clear();
  stubFetch([["/api/ops", { ok: true }], ["/api/titles", { titles: [] }]]);
  vi.mocked(tokenize.tokenizeBlock).mockClear();
});

test("an enqueue's pending count re-renders no block row", async () => {
  render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
      <SyncProvider replica={null}>
        <Grab />
        <EditablePage title="Page" initial={[
          block("u1", "first", { order_idx: 0 }),
          block("u2", "second", { order_idx: 1 }),
          block("u3", "third", { order_idx: 2 }),
        ]} />
      </SyncProvider>
    </MemoryRouter>);
  act(() => lastWs().open()); // connected: canEdit settles before we count
  const settled = tokenizeCalls();
  expect(settled).toBeGreaterThanOrEqual(3);

  // 0 -> 1 -> 0 pending, i.e. what every flushed edit does to the queue.
  await act(async () => { actions.enqueue([{ op: "delete", uid: "gone" }]); });

  expect(tokenizeCalls()).toBe(settled);
});
