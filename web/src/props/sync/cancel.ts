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
  cancel(): void;
  cancelled(): boolean;
}

/** `server` for one example. An abandoned example must not reach the
 * server the next example has reset: cancelled, its control refuses every
 * call, and its transports, which read the cookie for every request, refuse
 * to send. `server` itself stays usable. */
export function cancellable(server: ServerControl): Cancellable {
  let cancelled = false;
  const live = (): void => {
    if (cancelled) throw new ExampleCancelled("the example was cancelled: no more server calls");
  };
  return {
    server: {
      get cookie() { live(); return server.cookie; },
      reset: async () => { live(); await server.reset(); },
      setClock: async (ms) => { live(); await server.setClock(ms); },
      rotateGeneration: async () => { live(); await server.rotateGeneration(); },
      applied: async () => { live(); return server.applied(); },
      snapshot: async () => { live(); return server.snapshot(); },
      latestSeq: async () => { live(); return server.latestSeq(); },
      postRaw: async (body) => { live(); return server.postRaw(body); },
    },
    cancel: () => { cancelled = true; },
    cancelled: () => cancelled,
  };
}
