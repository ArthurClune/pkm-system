// pattern: Imperative Shell
// Thin fetch wrapper: JSON in/out; 401 -> login redirect. Offline (pkm-y8p0):
// when the websocket is down, requests route to the replica's local API
// shim first — same OpenAPI shapes, zero view changes. Routes the shim
// doesn't cover throw OfflineError so views can show a clear online-only
// state instead of a network failure.

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, path: string) {
    super(`request failed: ${status} ${path}`);
    this.status = status;
  }
}

/** The app is offline and the local shim does not serve this route. */
export class OfflineError extends ApiError {
  constructor(path: string) {
    super(0, path);
    this.message = `offline: ${path} is unavailable without a connection`;
  }
}

export function defaultUnauthorizedHandler(): void {
  window.location.href = "/login";
}

let onUnauthorized: () => void = defaultUnauthorizedHandler;

/** jsdom's location is unforgeable, so tests inject a spy here;
 * the app keeps the default redirect. */
export function setUnauthorizedHandler(handler: () => void): void {
  onUnauthorized = handler;
}

export interface GatewayResult {
  handled: boolean;
  status?: number;
  body?: unknown;
}

export interface OfflineGateway {
  /** True when requests should be served locally (socket not connected). */
  offline(): boolean;
  handle(path: string, init?: RequestInit): Promise<GatewayResult>;
}

let gateway: OfflineGateway | null = null;

/** Installed by SyncProvider once the replica is ready; null tears down. */
export function setOfflineGateway(gw: OfflineGateway | null): void {
  gateway = gw;
}

async function localFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await gateway!.handle(path, init);
  if (!res.handled) throw new OfflineError(path);
  if (res.status !== undefined && res.status >= 400) {
    throw new ApiError(res.status, path);
  }
  return res.body as T;
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  if (gateway?.offline()) {
    return localFetch<T>(path, init);
  }
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch (e: unknown) {
    // the socket status lags a just-dropped network by up to its reconnect
    // timer; a failed fetch inside that window falls back to the shim
    if (gateway) return localFetch<T>(path, init);
    throw e;
  }
  if (res.status === 401) {
    onUnauthorized();
    throw new ApiError(401, path);
  }
  if (!res.ok) {
    throw new ApiError(res.status, path);
  }
  return (await res.json()) as T;
}
