// pattern: Imperative Shell
// A path- and method-aware wrapper over apiFetch (pkm-60bf). apiFetch<T>
// lets a caller name ANY response type for ANY URL, so an obsolete caller
// type, an online/offline drift, or a wrong request body all typecheck.
// Here the OpenAPI path template and the HTTP verb are the arguments, and
// the generated `paths` table derives everything else: the path/query
// parameters, the JSON request body, and the response type.
//
// This is a typing layer only. It builds the same concrete URL the app used
// to hand-write, then calls apiFetch -- so the offline gateway dispatch, the
// 401 redirect and the ApiError/OfflineError behaviour are unchanged.
//
// Call it with the TEMPLATE, not the built URL:
//   apiGet("/api/page/{title}", { path: { title }, query: { bl_limit: 20 } })
//   apiPost("/api/pages", { body: { title } })

import { encodeTitle } from "../paths";
import { apiFetch } from "./client";
import type { paths } from "./types";

export type HttpMethod = "get" | "post" | "put" | "delete";

/** The paths that actually declare `M`. openapi-typescript writes the verbs
 * a path does NOT have as `verb?: never`, i.e. exactly `undefined`. */
export type PathFor<M extends HttpMethod> = {
  [P in keyof paths]: paths[P][M] extends undefined ? never : P;
}[keyof paths];

type Op<M extends HttpMethod, P extends PathFor<M>> = NonNullable<paths[P][M]>;

type ResponseOf<O> =
  O extends { responses: { 200: { content: { "application/json": infer R } } } }
    ? R : never;

/** `never` for a route with no JSON request body: an absent body is written
 * `requestBody?: never`, which does not satisfy the required-property test. */
type BodyOf<O> =
  O extends { requestBody: { content: { "application/json": infer B } } }
    ? B : never;

type PathParamsOf<O> = O extends { parameters: { path: infer PP } } ? PP : never;

/** Query params come through as required (`query: {...}`), optional
 * (`query?: {...}`) or absent (`query?: never`); NonNullable folds the last
 * case to `never` so the caller-facing type can drop the field entirely. */
type QueryParamsOf<O> =
  O extends { parameters: { query?: infer Q } } ? NonNullable<Q> : never;

// `{path?: undefined}` rather than an omitted key: passing parameters a route
// does not have is a mistake worth reporting, not something to ignore.
type PathPart<O> = [PathParamsOf<O>] extends [never]
  ? { path?: undefined }
  : { path: PathParamsOf<O> };

type QueryPart<O> = [QueryParamsOf<O>] extends [never]
  ? { query?: undefined }
  : Record<never, never> extends QueryParamsOf<O>
    ? { query?: QueryParamsOf<O> }
    : { query: QueryParamsOf<O> };

type BodyPart<O> = [BodyOf<O>] extends [never]
  ? { body?: undefined }
  : { body: BodyOf<O> };

export interface RequestExtras {
  /** Headers, signal, and friends. The method, the body and the URL belong
   * to the typed client; a caller cannot override them here. */
  init?: Omit<RequestInit, "method" | "body">;
}

type Options<O> = PathPart<O> & QueryPart<O> & BodyPart<O> & RequestExtras;

/** The options argument disappears for a route that needs nothing. */
type Args<O> = Record<never, never> extends Options<O>
  ? [options?: Options<O>]
  : [options: Options<O>];

/** The erased shape the URL/init builders work with. Options<O> is a
 * generic conditional type, so it cannot be *proved* assignable to this
 * without resolving O; the one cast below is where that proof is asserted.
 * It only concerns the REQUEST, and it is the only cast in this module --
 * response types come straight from the schema, never from a cast. */
interface RawOptions {
  path?: Record<string, string | number | boolean>;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  init?: Omit<RequestInit, "method" | "body">;
}

/** Path parameters are encoded per segment: the `{title:path}` routes take
 * namespace titles ("Work/Q3") whose slashes must stay literal. Every other
 * path parameter (uid, sha256, entry id, stored filename) is slash-free by
 * construction, so segment-wise encoding is plain encodeURIComponent there. */
function buildUrl(template: string, options: RawOptions | undefined): string {
  let url = template;
  for (const [name, value] of Object.entries(options?.path ?? {})) {
    // The function form of replace: a replacement STRING would interpret
    // "$&"/"$`" inside a page title as backreferences.
    url = url.replace(`{${name}}`, () => encodeTitle(String(value)));
  }
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(options?.query ?? {})) {
    if (value !== undefined) query.append(name, String(value));
  }
  const qs = query.toString();
  return qs.length > 0 ? `${url}?${qs}` : url;
}

function buildInit(method: string, options: RawOptions | undefined): RequestInit {
  const init: RequestInit = { ...options?.init, method };
  if (options?.body !== undefined) {
    init.headers = { "Content-Type": "application/json", ...options.init?.headers };
    init.body = JSON.stringify(options.body);
  }
  return init;
}

function send<R>(method: string, template: string,
                 options: RawOptions | undefined): Promise<R> {
  return apiFetch<R>(buildUrl(template, options), buildInit(method, options));
}

export function apiGet<P extends PathFor<"get">>(
  path: P, ...args: Args<Op<"get", P>>
): Promise<ResponseOf<Op<"get", P>>> {
  return send("GET", path, args[0] as RawOptions | undefined);
}

export function apiPost<P extends PathFor<"post">>(
  path: P, ...args: Args<Op<"post", P>>
): Promise<ResponseOf<Op<"post", P>>> {
  return send("POST", path, args[0] as RawOptions | undefined);
}

export function apiPut<P extends PathFor<"put">>(
  path: P, ...args: Args<Op<"put", P>>
): Promise<ResponseOf<Op<"put", P>>> {
  return send("PUT", path, args[0] as RawOptions | undefined);
}

export function apiDelete<P extends PathFor<"delete">>(
  path: P, ...args: Args<Op<"delete", P>>
): Promise<ResponseOf<Op<"delete", P>>> {
  return send("DELETE", path, args[0] as RawOptions | undefined);
}
