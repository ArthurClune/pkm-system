// pattern: Functional Core
// Minimal request/response RPC over a MessagePort-like. The worker serves,
// the main thread calls; errors cross the boundary as {message, quota} so
// the storage-quota signal (spec section 6) survives serialization.

export interface PortLike {
  postMessage(msg: unknown): void;
  onmessage: ((ev: { data: unknown }) => void) | null;
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
  call<T>(method: string, payload?: unknown): Promise<T>;
}

export function createRpcClient(port: PortLike): RpcClient {
  let nextId = 1;
  const pending = new Map<number, {
    resolve: (v: unknown) => void;
    reject: (e: unknown) => void;
  }>();
  port.onmessage = (ev) => {
    const res = ev.data as RpcResponse;
    const p = pending.get(res.id);
    if (!p) return;
    pending.delete(res.id);
    if (res.error) p.reject(new ReplicaError(res.error.message, res.error.quota));
    else p.resolve(res.result);
  };
  return {
    call<T>(method: string, payload?: unknown): Promise<T> {
      const id = nextId++;
      return new Promise<T>((resolve, reject) => {
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
        port.postMessage({ id, method, payload } as RpcRequest);
      });
    },
  };
}
