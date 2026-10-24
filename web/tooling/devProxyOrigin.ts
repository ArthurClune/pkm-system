// pattern: Functional Core
// The Origin the Vite dev proxy forwards to the backend. A page served by
// the dev server sends the dev server's origin, which the backend refuses
// on /api/ws and unsafe methods, so that one origin becomes the backend's
// own. Any other origin passes through unchanged and the backend refuses
// it: rewriting every origin would let any page on localhost write to the
// backend (by default production's) through the proxy.

/**
 * The Origin to send upstream, or undefined to leave the header as it is.
 * `host` is the Host header the dev server received; `target` is the
 * backend's origin.
 */
export function devProxyOrigin(
  origin: string | undefined,
  host: string | undefined,
  target: string,
): string | undefined {
  if (origin === undefined || host === undefined) return undefined;
  return origin === `http://${host}` ? target : undefined;
}
