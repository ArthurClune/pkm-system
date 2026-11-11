// The specs' one read of an untyped value off the wire, as `apiFetch` is the
// app's: a JSON body, a request's posted data, or a worker's reply. The
// caller names the type it expects; the server owns the brands it carries.

/** A request or response body, typed as its route's model. */
export function wireModel<T>(body: unknown): T {
  // brand: untrusted -- a value off the wire, typed by the caller
  return body as T;
}

/** A response's body (Playwright's `APIResponse`, or a page's `Response`),
 * typed as its route's model. */
export async function serverJson<T>(res: { json(): Promise<unknown> }): Promise<T> {
  return wireModel<T>(await res.json());
}
