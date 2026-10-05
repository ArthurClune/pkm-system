// pattern: Imperative Shell
// One example's handle on the server, which the example gives up when it is
// over: the property abandons an example that hangs, and fast-check's time
// limit abandons the one it cuts into, and either may still be running.
import type { ServerControl } from "./serverControl";

export class ExampleCancelled extends Error {
  override name = "ExampleCancelled";
}

export interface Cancellable {
  /** Throws on every call, the cookie included, once cancel() has run. */
  server: ServerControl;
  /** Aborted by cancel(): every request the example makes carries it, so one
   * already on the wire is cut off rather than committing after the next
   * example's reset. */
  signal: AbortSignal;
  cancel(): void;
  cancelled(): boolean;
}

/** `server` for one example. An abandoned example must not reach the
 * server the next example has reset: cancelled, its control refuses every
 * call, and its transports, which read the cookie for every request, refuse
 * to send, and a request already on the wire is aborted. `server` itself
 * stays usable. */
export function cancellable(server: ServerControl): Cancellable {
  let cancelled = false;
  const controller = new AbortController();
  const bound = server.withSignal(controller.signal);
  const live = (): void => {
    if (cancelled) throw new ExampleCancelled("the example was cancelled: no more server calls");
  };
  return {
    server: {
      get cookie() { live(); return bound.cookie; },
      reset: async () => { live(); await bound.reset(); },
      setClock: async (ms) => { live(); await bound.setClock(ms); },
      rotateGeneration: async () => { live(); await bound.rotateGeneration(); },
      applied: async () => { live(); return bound.applied(); },
      renames: async () => { live(); return bound.renames(); },
      snapshot: async () => { live(); return bound.snapshot(); },
      takeEcho: async () => { live(); return bound.takeEcho(); },
      setEchoTeeth: async (on) => { live(); await bound.setEchoTeeth(on); },
      changes: async (since) => { live(); return bound.changes(since); },
      latestSeq: async () => { live(); return bound.latestSeq(); },
      postRaw: async (body) => { live(); return bound.postRaw(body); },
      postRename: async (from, to) => { live(); return bound.postRename(from, to); },
      withSignal: (next) => { live(); return server.withSignal(next); },
    },
    signal: controller.signal,
    cancel: () => { cancelled = true; controller.abort(); },
    cancelled: () => cancelled,
  };
}
