// Drift probes and behaviour tests for the generated-type API boundary
// (pkm-60bf). Most of this file is a COMPILE-time test: `pnpm typecheck` is
// what runs it. Every expected-error directive below must stay an error --
// TypeScript reports an UNUSED suppression as an error of its own, so a probe
// that stops catching its drift fails the build rather than silently passing.
import { afterEach, expect, it, vi } from "vitest";
import type { CurrentWorkPayload, JournalPayload, PageMeta,
              PagePayload } from "./payloads";
import { setOfflineGateway } from "./client";
import { apiDelete, apiGet, apiPost, apiPut } from "./typedClient";
import type { paths } from "./types";

// --- rename's concrete response model (was `{[key: string]: unknown}`) ---

type RenameResponse =
  paths["/api/page/{title}/rename"]["post"]["responses"][200]["content"]["application/json"];

it("types the rename response as a discriminated result", () => {
  const renamed: RenameResponse = { result: "renamed", title: "New" };
  const branch: "renamed" | "merged" = renamed.result;
  expect(branch).toBe("renamed");
});

// --- the path + method determine the response type ---

function responseTypes() {
  const page: Promise<PagePayload> =
    apiGet("/api/page/{title}", { path: { title: "T" } });
  const work: Promise<CurrentWorkPayload> = apiGet("/api/current-work");
  const created: Promise<PageMeta> =
    apiPost("/api/pages", { body: { title: "T" } });
  const renamed: Promise<RenameResponse> =
    apiPost("/api/page/{title}/rename", {
      path: { title: "T" },
      body: { new_title: "U", allow_merge: false },
    });
  return { page, work, created, renamed };
}

// A caller can no longer name a response type the route does not return.
function wrongResponseType() {
  // @ts-expect-error /api/page/{title} returns PagePayload, not JournalPayload
  const wrong: Promise<JournalPayload> =
    apiGet("/api/page/{title}", { path: { title: "T" } });
  return wrong;
}

function methodAndPathAreChecked() {
  // Options are supplied on purpose: without them the call would fail on
  // arity alone, which is not the drift these probes are pinning down.
  // @ts-expect-error /api/journal has no POST
  apiPost("/api/journal", { query: { days: 7 } });
  // @ts-expect-error no such route in the schema
  apiGet("/api/not-a-route", { query: { q: "x" } });
  // @ts-expect-error /api/sidebar has no DELETE (only /api/sidebar/{entry_id})
  apiDelete("/api/sidebar", {});
}

function parametersAreChecked() {
  // @ts-expect-error {title} is a required path parameter
  apiGet("/api/page/{title}", {});
  // @ts-expect-error /api/current-work takes no path parameters
  apiGet("/api/current-work", { path: { title: "T" } });
  // @ts-expect-error bl_limitt is not a query parameter of this route
  apiGet("/api/page/{title}", { path: { title: "T" }, query: { bl_limitt: 5 } });
  // @ts-expect-error `uids` is a REQUIRED query parameter of /api/block-refs
  apiGet("/api/block-refs");
  // @ts-expect-error bl_limit is a number
  apiGet("/api/page/{title}", { path: { title: "T" }, query: { bl_limit: "5" } });
}

function headersMustBeAPlainRecord() {
  // @ts-expect-error a Headers instance would be dropped by the merge
  apiGet("/api/current-work", { init: { headers: new Headers() } });
}

function requestBodiesAreChecked() {
  // @ts-expect-error the field is `title`, not `titel`
  apiPost("/api/pages", { body: { titel: "T" } });
  // @ts-expect-error POST /api/pages requires a body
  apiPost("/api/pages");
  // @ts-expect-error GET /api/current-work takes no request body
  apiGet("/api/current-work", { body: { title: "T" } });
}

// --- runtime behaviour: URL building and dispatch through apiFetch ---

afterEach(() => {
  vi.unstubAllGlobals();
  setOfflineGateway(null);
});

function stubFetch(body: unknown = { ok: true }) {
  const fetchMock = vi.fn().mockResolvedValue(new Response(
    JSON.stringify(body), { headers: { "Content-Type": "application/json" } }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

it("substitutes path parameters, keeping namespace slashes literal", async () => {
  const fetchMock = stubFetch();
  await apiGet("/api/page/{title}", { path: { title: "Work/Q3 plan" } });
  expect(fetchMock.mock.calls[0][0]).toBe("/api/page/Work/Q3%20plan");
});

it("encodes a title containing regexp replacement syntax literally", async () => {
  // "$&" in a String.replace REPLACEMENT means "the whole match"; a title
  // like this used to be able to inject the placeholder back into the URL.
  const fetchMock = stubFetch();
  await apiGet("/api/page/{title}", { path: { title: "$& $`" } });
  expect(fetchMock.mock.calls[0][0]).toBe("/api/page/%24%26%20%24%60");
});

it("appends supplied query parameters and drops undefined ones", async () => {
  const fetchMock = stubFetch();
  await apiGet("/api/page/{title}",
               { path: { title: "T" }, query: { bl_limit: 5, bl_offset: undefined } });
  expect(fetchMock.mock.calls[0][0]).toBe("/api/page/T?bl_limit=5");
});

it("form-encodes query values, which the shim and the server both decode", async () => {
  const fetchMock = stubFetch({ pages: [], blocks: [] });
  await apiGet("/api/search", { query: { q: "hello world" } });
  expect(fetchMock.mock.calls[0][0]).toBe("/api/search?q=hello+world");
  const shimmed = new URL(String(fetchMock.mock.calls[0][0]), "http://x");
  expect(shimmed.searchParams.get("q")).toBe("hello world");
});

it("omits a null query value rather than sending the string \"null\"", async () => {
  // Five query params are generated as `| null` (before, now_ms, page,
  // from_ms, to_ms), so a `string | null` cursor typechecks here. FastAPI
  // declares them `str | None = None`, which means a literal "?before=null"
  // arrives as the STRING "null" -- not None -- and then 400s on the date
  // parse. Absent is the only encoding of "no value" the server understands.
  const fetchMock = stubFetch({ days: [], block_ref_texts: {} });
  const cursor: string | null = null;
  await apiGet("/api/journal", { query: { before: cursor, days: 5 } });
  expect(fetchMock.mock.calls[0][0]).toBe("/api/journal?days=5");
});

it("omits the query string entirely when nothing is supplied", async () => {
  const fetchMock = stubFetch();
  await apiGet("/api/current-work");
  expect(fetchMock.mock.calls[0]).toEqual(["/api/current-work", { method: "GET" }]);
});

it("sends a JSON body with the method the path declares", async () => {
  const fetchMock = stubFetch();
  await apiPost("/api/page/{title}/rename",
                { path: { title: "Old" }, body: { new_title: "New", allow_merge: true } });
  expect(fetchMock.mock.calls[0]).toEqual([
    "/api/page/Old/rename",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ new_title: "New", allow_merge: true }),
    },
  ]);
});

it("sends a PUT with the body its schema declares", async () => {
  const fetchMock = stubFetch();
  await apiPut("/api/sidebar", { body: { order: [3, 1] } });
  expect(fetchMock.mock.calls[0]).toEqual(["/api/sidebar", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ order: [3, 1] }),
  }]);
});

it("sends no body or content type for a bodyless write", async () => {
  const fetchMock = stubFetch();
  await apiDelete("/api/page/{title}", { path: { title: "T" } });
  expect(fetchMock.mock.calls[0]).toEqual(["/api/page/T", { method: "DELETE" }]);
});

it("passes extra init through and lets the caller's headers win", async () => {
  const fetchMock = stubFetch();
  const signal = AbortSignal.abort();
  await apiPost("/api/pages",
                { body: { title: "T" }, init: { signal, headers: { "X-Test": "1" } } })
    .catch(() => undefined);
  expect(fetchMock.mock.calls[0][1]).toEqual({
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json", "X-Test": "1" },
    body: JSON.stringify({ title: "T" }),
  });
});

it("still routes through the offline gateway", async () => {
  const fetchMock = stubFetch();
  setOfflineGateway({
    offline: () => true,
    handle: async (path) => ({ handled: true, status: 200,
                               body: { sections: [], path } }),
  });
  const payload = await apiGet("/api/current-work");
  expect(payload).toEqual({ sections: [], path: "/api/current-work" });
  expect(fetchMock).not.toHaveBeenCalled();
});

// Referenced so `noUnusedLocals` does not delete the compile-time probes and
// so a probe helper that throws at runtime would be noticed.
it("keeps the compile-time probes referenced", () => {
  expect(typeof responseTypes).toBe("function");
  expect(typeof wrongResponseType).toBe("function");
  expect(typeof methodAndPathAreChecked).toBe("function");
  expect(typeof parametersAreChecked).toBe("function");
  expect(typeof headersMustBeAPlainRecord).toBe("function");
  expect(typeof requestBodiesAreChecked).toBe("function");
});
