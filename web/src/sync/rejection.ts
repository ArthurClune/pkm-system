// pattern: Functional Core
// A 4xx from require_auth (session expiry, a rotated secret, a cleared
// cookie) or a transient overload says nothing about the batch's content, so
// it retries under backoff instead of poisoning or discarding the batch —
// only a status that actually describes a rejected batch is terminal.
import type { ApiError } from "../api/client";

const RETRY_LATER_STATUSES: ReadonlySet<number> = new Set([401, 403, 408, 429]);

/** True only for an `ApiError` in the 4xx range that is not one of the
 * retry-later statuses above. Anything else — a 5xx, a non-`ApiError`
 * failure such as a dropped fetch or an offline error — is not a terminal
 * rejection. A `true` result narrows `error` to `ApiError` for the caller;
 * `false` does not imply the opposite (a 5xx `ApiError` also returns
 * false), it only means the caller must not treat it as one.
 *
 * Checks `"status" in error` rather than `instanceof ApiError`: this file is
 * Functional Core, and `ApiError` is a class in the Imperative Shell's
 * `api/client.ts`, so a value import of it here would cross the FCIS
 * boundary. Only `ApiError` carries a numeric `status` today, so the duck
 * type is exact; a future Error subclass with its own `status` field would
 * need this check revisited. */
export function isTerminalRejection(error: unknown): error is ApiError {
  if (!(error instanceof Error) || !("status" in error)) return false;
  const apiError = error as ApiError;
  return (
    apiError.status >= 400 &&
    apiError.status < 500 &&
    !RETRY_LATER_STATUSES.has(apiError.status)
  );
}
