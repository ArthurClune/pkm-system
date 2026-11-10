// The specs' one read of a JSON body on the wire, as `apiFetch` is the
// app's: the caller names the route's generated model, and the server owns
// the brands it carries.

/** A request or response body, typed as its route's model. */
export function wireModel<T>(body: unknown): T {
  // brand: untrusted -- a JSON body on the wire, typed by the caller's route
  return body as T;
}

/** A response's body (Playwright's `APIResponse`, or a page's `Response`),
 * typed as its route's model. */
export async function serverJson<T>(res: { json(): Promise<unknown> }): Promise<T> {
  return wireModel<T>(await res.json());
}
