// pattern: Imperative Shell
// The chat driver property's teeth: the real driver behind a changed client
// or dispatch, each change a bug in the shell's I/O order the property must
// catch. A catch counts only when a problem names the invariant the bug
// breaks (driverRun.ts lists them).
import fc from "fast-check";
import { expect, test } from "vitest";
import { ApiError } from "../../api/client";
import type { ConversationId } from "../../api/brands";
import {
  createChatDriver, STOP_ACK_TIMEOUT_MS, type ChatClient, type ChatDriver,
} from "../../assistant/chatDriver";
import type { ChatEvent } from "../../assistant/chatMachine";
import { SEED } from "../env";
import { expectMutantsCaught } from "../gate";
import { captureFaultWarnings } from "../warningsCapture";
import { driverActionsArb, type DriverAction } from "./driverArbitraries";
import { fakeDriverClock, REAL_DRIVER, runDriverActions, type MakeDriver } from "./driverRun";

captureFaultWarnings("assistant driver teeth");
fakeDriverClock();

const NUM_RUNS = 20_000;
const TIME_LIMIT_MS = 15_000;
const CLEAN_RUNS = 5_000;

type Change = {
  client?: Partial<ChatClient>;
  dispatch?: (real: ChatDriver["dispatch"], event: ChatEvent) => Promise<void>;
};

/** The real driver, with `change` applied to the client it is given and to
 * the dispatch the run calls. `self` reads the driver once it is built. */
function mutant(change: (client: ChatClient, self: () => ChatDriver) => Change): MakeDriver {
  return (publish, client) => {
    let driver: ChatDriver | null = null;
    const self = (): ChatDriver => {
      if (driver === null) throw new Error("the driver is not built yet");
      return driver;
    };
    const c = change(client, self);
    const real = createChatDriver(publish, { ...client, ...c.client });
    const dispatch = c.dispatch;
    driver = dispatch === undefined ? real : { ...real, dispatch: (e) => dispatch(real.dispatch, e) };
    return driver;
  };
}

/** Hands each stream a signal of its own that follows the driver's only
 * when `follows` says so; `latest` aborts the newest stream's own signal. */
function relaySignals(client: ChatClient, follows: () => boolean): {
  streamMessage: ChatClient["streamMessage"]; latest: () => void;
} {
  let newest: AbortController | null = null;
  return {
    streamMessage: (id, text, onEvent, signal, onOpen) => {
      const own = new AbortController();
      newest = own;
      if (signal?.aborted) own.abort();
      signal?.addEventListener("abort", () => { if (follows()) own.abort(); });
      return client.streamMessage(id, text, onEvent, own.signal, onOpen);
    },
    latest: () => { newest?.abort(); },
  };
}

const MUTANTS: Record<string, { catches: readonly string[]; make: MakeDriver }> = {
  "New chat sends the DELETE before the aborted stream settles": {
    catches: ["delete"],
    make: mutant((client, self) => {
      const early = new Set<ConversationId>();
      return {
        client: { deleteConversation: (id) => (early.has(id) ? Promise.resolve()
          : client.deleteConversation(id)) },
        dispatch: (real, e) => {
          const conv = self().current().conversation;
          const done = real(e);
          if (e.type === "newChat" && conv.kind === "open") {
            early.add(conv.id);
            void client.deleteConversation(conv.id).catch(() => {});
          }
          return done;
        },
      };
    }),
  },
  "a DELETE is never sent": {
    catches: ["delete"],
    make: mutant(() => ({ client: { deleteConversation: () => Promise.resolve() } })),
  },
  "an old stream's event is dispatched for the turn busy when it arrives": {
    catches: ["agree"],
    make: mutant((client, self) => ({ client: {
      streamMessage: (id, text, _onEvent, signal, onOpen) => client.streamMessage(id, text, (ev) => {
        const s = self().current();
        const turn = s.turn.phase === "idle" ? s.lastTurn : s.turn.id;
        void self().dispatch({ type: "streamEvent", turn, event: ev, at: Date.now() });
      }, signal, onOpen),
    } })),
  },
  "a stop counts as settled when it is sent": {
    catches: ["agree"],
    make: mutant((client) => ({ client: {
      stopTurn: (id, signal) => {
        void client.stopTurn(id, signal).catch(() => {});
        return Promise.resolve();
      },
    } })),
  },
  // A second stream at once: New chat leaves the old one running.
  "New chat's abort never reaches the stream": {
    catches: ["one"],
    make: mutant((client) => {
      let muted = false;
      const relay = relaySignals(client, () => !muted);
      return {
        client: { streamMessage: relay.streamMessage },
        dispatch: (real, e) => {
          muted = e.type === "newChat";
          try {
            return real(e);
          } finally {
            muted = false;
          }
        },
      };
    }),
  },
  "the stream ignores its abort signal": {
    catches: ["abort", "one", "fallback"],
    make: mutant((client) => ({ client: { streamMessage: relaySignals(client, () => false).streamMessage } })),
  },
  "the stop is posted before the stream's response opens": {
    catches: ["stop"],
    make: mutant((client) => ({ client: {
      streamMessage: (id, text, onEvent, signal, onOpen) => {
        onOpen?.();
        return client.streamMessage(id, text, onEvent, signal);
      },
    } })),
  },
  "the stop is never posted": {
    catches: ["stop"],
    make: mutant(() => ({ client: { stopTurn: () => new Promise<void>(() => {}) } })),
  },
  "Stop aborts the stream at once": {
    catches: ["abort"],
    make: mutant((client, self) => {
      const relay = relaySignals(client, () => true);
      return {
        client: { streamMessage: relay.streamMessage },
        dispatch: (real, e) => {
          const streaming = self().current().turn.phase === "streaming";
          const done = real(e);
          if (e.type === "stop" && streaming) relay.latest();
          return done;
        },
      };
    }),
  },
  "a failed stop POST counts as acknowledged": {
    catches: ["fallback"],
    make: mutant((client) => ({ client: {
      stopTurn: (id, signal) => client.stopTurn(id, signal).catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") throw err;
      }),
    } })),
  },
  // Only an abort made inside a dispatch reaches the stream, so the timer's
  // and a failed POST's never do.
  "the stop's fallback never reaches the stream": {
    catches: ["fallback", "abort"],
    make: mutant((client) => {
      let dispatching = false;
      const relay = relaySignals(client, () => dispatching);
      return {
        client: { streamMessage: relay.streamMessage },
        dispatch: (real, e) => {
          dispatching = true;
          try {
            return real(e);
          } finally {
            dispatching = false;
          }
        },
      };
    }),
  },
  "the stop's fallback waits twice STOP_ACK_TIMEOUT_MS": {
    catches: ["fallback"],
    make: mutant(() => ({
      dispatch: (real, e) => {
        if (e.type !== "stop") return real(e);
        // Swapped by hand, not with vi.spyOn: once the file ends vitest
        // restores every spy it ever made, which would put this test's fake
        // setTimeout back after its clock is gone, and no timer would fire
        // in the process again.
        const armed = globalThis.setTimeout;
        globalThis.setTimeout = ((handler: () => void, ms?: number) =>
          armed(handler, ms === STOP_ACK_TIMEOUT_MS ? 2 * ms : ms)) as typeof setTimeout;
        try {
          return real(e);
        } finally {
          globalThis.setTimeout = armed;
        }
      },
    })),
  },
  // The back-off's retry goes out whatever happened while it slept.
  "a 409 is retried after Stop": {
    catches: ["retry"],
    make: mutant((client, self) => ({ client: {
      streamMessage: async (id, text, onEvent, signal, onOpen) => {
        try {
          await client.streamMessage(id, text, onEvent, signal, onOpen);
        } catch (err) {
          if (!(err instanceof ApiError && err.status === 409)
              || self().current().turn.phase !== "streaming") throw err;
          await new Promise((resolve) => { setTimeout(resolve, 60); });
          await client.streamMessage(id, text, onEvent, signal, onOpen);
        }
      },
    } })),
  },
  "a confirm answer is never sent": {
    catches: ["run"],
    make: mutant(() => ({ client: { confirmTool: () => new Promise<void>(() => {}) } })),
  },
};

expectMutantsCaught({
  suite: "assistant driver property", mutants: MUTANTS, arbs: [driverActionsArb],
  problems: async (m, actions: DriverAction[]) => (await runDriverActions(actions, m.make)).problems,
  numRuns: NUM_RUNS, limitMs: TIME_LIMIT_MS,
});

test("the real driver passes the same runs", async () => {
  const details = await fc.check(fc.asyncProperty(driverActionsArb, async (actions) => {
    const { problems } = await runDriverActions(actions, REAL_DRIVER);
    if (problems.length > 0) throw new Error(problems.join("\n"));
  }), { numRuns: CLEAN_RUNS, seed: SEED });
  expect(details.failed, `clean run failed (seed ${details.seed}):` +
    ` ${String(details.errorInstance)}`).toBe(false);
});
