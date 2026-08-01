// pattern: Imperative Shell
// Thin fetch wrapper: JSON in/out; 401 -> login redirect. Offline (pkm-y8p0):
// when the websocket is down, requests route to the replica's local API
// shim first — same OpenAPI shapes, zero view changes. Routes the shim
// doesn't cover throw OfflineError so views can show a clear online-only
// state instead of a network failure.

export class ApiError extends Error {
  readonly status: number;
  /** The server's `{"detail": "..."}` body, when present (pkm-c98s item 5):
   * e.g. the assistant's 409 "at most 3 concurrent conversations". */
  readonly detail?: string;

  constructor(status: number, path: string, detail?: string) {
    super(detail ? `request failed: ${status} ${path}: ${detail}` : `request failed: ${status} ${path}`);
    this.status = status;
    this.detail = detail;
  }
}

/** Best-effort extraction of a FastAPI-shaped `{"detail": "..."}` error
 * body. Returns undefined for non-JSON bodies or bodies without a string
 * `detail` field; never throws. */
export async function readErrorDetail(res: Response): Promise<string | undefined> {
  try {
    const body: unknown = await res.clone().json();
    if (body && typeof body === "object" && typeof (body as { detail?: unknown }).detail === "string") {
      return (body as { detail: string }).detail;
    }
  } catch {
    // not JSON (or already consumed) -- no detail available
  }
  return undefined;
}

function detailFromBody(body: unknown): string | undefined {
  if (body && typeof body === "object" && typeof (body as { detail?: unknown }).detail === "string") {
    return (body as { detail: string }).detail;
  }
  return undefined;
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

/** Calls the currently-installed unauthorized handler (for internal use by
 * fetch-like functions that bypass apiFetch). */
export function callUnauthorizedHandler(): void {
  onUnauthorized();
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
    throw new ApiError(res.status, path, detailFromBody(res.body));
  }
  return res.body as T;
}

/** The transport. `T` is whatever the caller names, unchecked against the
 * URL and the method -- prefer `typedClient.ts`'s apiGet/apiPost/apiPut/
 * apiDelete, which derive `T` (and the body, and the parameters) from the
 * generated schema and then call this (pkm-60bf). Reach for apiFetch
 * directly only where the schema cannot express the request, e.g. the
 * multipart asset upload. */
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
    throw new ApiError(401, path, await readErrorDetail(res));
  }
  if (!res.ok) {
    throw new ApiError(res.status, path, await readErrorDetail(res));
  }
  return (await res.json()) as T;
}
