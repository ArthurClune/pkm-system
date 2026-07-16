// pkm-wquz: Cmd/Ctrl-Enter cycles a block plain -> TODO -> DONE -> plain,
// wired through useOutline's onCycleTodo handler (the imperative half of the
// pure cycleTodo in grammar/todo.ts).
import { act, render } from "@testing-library/react";
import { useEffect } from "react";
import { expect, it } from "vitest";
import type { BlockNode } from "../api/payloads";
import { SyncContext } from "../sync/SyncProvider";
import { block, makeSync, type SyncFake } from "../test-helpers";
import { useOutline, type Outline } from "./useOutline";

function Harness({ pageTitle, initial, onReady }: {
  pageTitle: string;
  initial: BlockNode[];
  onReady: (o: Outline) => void;
}) {
  const outline = useOutline(pageTitle, initial);
  useEffect(() => onReady(outline));
  return null;
}

function setup(sync: SyncFake, pageTitle: string, initial: BlockNode[]) {
  let outline!: Outline;
  render(
    <SyncContext.Provider value={sync}>
      <Harness pageTitle={pageTitle} initial={initial}
               onReady={(o) => { outline = o; }} />
    </SyncContext.Provider>);
  return () => outline;
}

it("onCycleTodo cycles a block plain -> TODO -> DONE -> plain", () => {
  const sync = makeSync();
  const getOutline = setup(sync, "Page", [block("a", "buy milk")]);

  act(() => getOutline().handlers.onCycleTodo("a"));
  expect(getOutline().blocks[0].text).toBe("{{TODO}} buy milk");
  expect(sync.sent).toEqual([[{ op: "update_text", uid: "a", text: "{{TODO}} buy milk" }]]);

  act(() => getOutline().handlers.onCycleTodo("a"));
  expect(getOutline().blocks[0].text).toBe("{{DONE}} buy milk");

  act(() => getOutline().handlers.onCycleTodo("a"));
  expect(getOutline().blocks[0].text).toBe("buy milk");
});

it("onCycleTodo flushes a pending debounced draft edit before cycling", () => {
  const sync = makeSync();
  const getOutline = setup(sync, "Page", [block("a", "buy milk")]);

  // Simulate an in-flight (not yet debounce-flushed) draft edit.
  act(() => getOutline().handlers.onDraftChange("a", "buy oat milk"));
  act(() => getOutline().handlers.onCycleTodo("a"));

  expect(getOutline().blocks[0].text).toBe("{{TODO}} buy oat milk");
});
