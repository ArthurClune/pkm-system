// pattern: Imperative Shell
// Thin fetch wrapper: JSON in/out; 401 -> login redirect.

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, path: string) {
    super(`request failed: ${status} ${path}`);
    this.status = status;
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

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (res.status === 401) {
    onUnauthorized();
    throw new ApiError(401, path);
  }
  if (!res.ok) {
    throw new ApiError(res.status, path);
  }
  return (await res.json()) as T;
}
