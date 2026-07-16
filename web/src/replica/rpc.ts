// pattern: Imperative Shell
// MessagePort RPC transport and lifecycle shell: installs port handlers, owns
// mutable request/timer state, posts messages, and disposes terminal resources.
// Errors cross as {message, quota} so the storage-quota signal survives.

export interface PortLike {
  postMessage(msg: unknown): void;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror?: ((ev: { error?: unknown; message?: string }) => void) | null;
  onmessageerror?: ((ev: { data?: unknown }) => void) | null;
}

/** MessagePort/Worker are PortLike in behaviour, but their `onmessage`
 * property types (this-bound, full MessageEvent) defeat structural
 * assignability — adapt via this one sanctioned cast. */
export function toPortLike(port: {
  postMessage(msg: unknown): void;
  onmessage: unknown;
}): PortLike {
  return port as unknown as PortLike;
}

interface RpcRequest { id: number; method: string; payload: unknown }
interface RpcResponse {
  id: number;
  result?: unknown;
  error?: { message: string; quota: boolean };
}

export class ReplicaError extends Error {
  readonly quota: boolean;

  constructor(message: string, quota: boolean) {
    super(message);
    this.quota = quota;
  }
}

export type RpcLifecycleKind =
  | "worker-error"
  | "message-error"
  | "timeout"
  | "disposed";

export class RpcLifecycleError extends Error {
  readonly kind: RpcLifecycleKind;
  override readonly cause: unknown;

  constructor(kind: RpcLifecycleKind, message: string, cause?: unknown) {
    super(message);
    this.name = "RpcLifecycleError";
    this.kind = kind;
    this.cause = cause;
  }
}

export type RpcHandlers = Record<string, (payload: unknown) => Promise<unknown>>;

export function serveRpc(port: PortLike, handlers: RpcHandlers): void {
  port.onmessage = (ev) => {
    const req = ev.data as RpcRequest;
    const handler = handlers[req.method];
    const run = handler
      ? handler(req.payload)
      : Promise.reject(new Error(`unknown replica method: ${req.method}`));
    void run.then(
      (result) => port.postMessage({ id: req.id, result } as RpcResponse),
      (e: unknown) => port.postMessage({
        id: req.id,
        error: {
          message: e instanceof Error ? e.message : String(e),
          quota: Boolean((e as { quota?: boolean })?.quota),
        },
      } as RpcResponse),
    );
  };
}

export interface RpcClient {
  call<T>(method: string, payload?: unknown,
          options?: { timeoutMs?: number }): Promise<T>;
  dispose(reason?: Error): void;
}

export function createRpcClient(port: PortLike): RpcClient {
  let nextId = 1;
  let terminal: RpcLifecycleError | null = null;
  const pending = new Map<number, {
    resolve: (v: unknown) => void;
    reject: (e: unknown) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  const failTerminal = (error: RpcLifecycleError): void => {
    if (terminal) return;
    terminal = error;
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    pending.clear();
  };
  port.onmessage = (ev) => {
    const res = ev.data as RpcResponse;
    const p = pending.get(res.id);
    if (!p) return;
    pending.delete(res.id);
    clearTimeout(p.timer);
    if (res.error) p.reject(new ReplicaError(res.error.message, res.error.quota));
    else p.resolve(res.result);
  };
  port.onerror = (ev) => failTerminal(new RpcLifecycleError(
    "worker-error",
    ev.message ?? (ev.error instanceof Error ? ev.error.message : "replica worker failed"),
    ev.error,
  ));
  port.onmessageerror = (ev) => failTerminal(new RpcLifecycleError(
    "message-error", "replica worker message could not be decoded", ev.data));
  return {
    call<T>(method: string, payload?: unknown,
            options?: { timeoutMs?: number }): Promise<T> {
      if (terminal) return Promise.reject(terminal);
      const id = nextId++;
      return new Promise<T>((resolve, reject) => {
        const timeoutMs = options?.timeoutMs ?? 30_000;
        const timer = setTimeout(() => {
          if (!pending.delete(id)) return;
          reject(new RpcLifecycleError(
            "timeout", `replica RPC ${method} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        pending.set(id, {
          resolve: resolve as (v: unknown) => void,
          reject,
          timer,
        });
        try {
          port.postMessage({ id, method, payload } as RpcRequest);
        } catch (error: unknown) {
          clearTimeout(timer);
          pending.delete(id);
          reject(error);
        }
      });
    },
    dispose(reason?: Error): void {
      failTerminal(new RpcLifecycleError(
        "disposed", reason?.message ?? "replica RPC client disposed", reason));
    },
  };
}
