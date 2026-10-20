// Drift probes and behaviour tests for the generated-type API boundary.
// The typeProbe blocks are COMPILE-time tests: `pnpm typecheck` is what runs
// them. Every expected-error directive below must stay an error --
// TypeScript reports an UNUSED suppression as an error of its own, so a probe
// that stops catching its drift fails the build rather than silently passing.
import { afterEach, expect, it, vi } from "vitest";
import { READ_INIT, sidebarEntryIdOf, canonicalTitleOf, typeProbe, rawTitleOf } from "../test-helpers";
import type { CurrentWorkPayload, JournalPayload, PageMeta,
              PagePayload } from "./payloads";
import { setOfflineGateway } from "./client";
import { apiDelete, apiGet, apiPost, apiPut } from "./typedClient";
import type { paths } from "./types";

// --- rename's concrete response model (was `{[key: string]: unknown}`) ---

type RenameResponse =
  paths["/api/page/{title}/rename"]["post"]["responses"][200]["content"]["application/json"];

it("types the rename response as a discriminated result", () => {
  const renamed: RenameResponse = { result: "renamed", title: canonicalTitleOf("New") };
  const branch: "renamed" | "merged" = renamed.result;
  expect(branch).toBe("renamed");
});

// --- the path + method determine the response type ---

typeProbe(() => {
  const page: Promise<PagePayload> =
    apiGet("/api/page/{title}", { path: { title: rawTitleOf("T") } });
  const work: Promise<CurrentWorkPayload> = apiGet("/api/current-work");
  const created: Promise<PageMeta> =
    apiPost("/api/pages", { body: { title: rawTitleOf("T") } });
  const renamed: Promise<RenameResponse> =
    apiPost("/api/page/{title}/rename", {
      path: { title: rawTitleOf("T") },
      body: { new_title: rawTitleOf("U"), allow_merge: false },
    });
  void [page, work, created, renamed];
});

// A caller can no longer name a response type the route does not return.
typeProbe(() => {
  // @ts-expect-error /api/page/{title} returns PagePayload, not JournalPayload
  const wrong: Promise<JournalPayload> =
    apiGet("/api/page/{title}", { path: { title: rawTitleOf("T") } });
  void wrong;
});

typeProbe(() => {
  // Options are supplied on purpose: without them the call would fail on
  // arity alone, which is not the drift these probes are pinning down.
  // @ts-expect-error /api/journal has no POST
  void apiPost("/api/journal", { query: { days: 7 } });
  // @ts-expect-error no such route in the schema
  void apiGet("/api/not-a-route", { query: { q: "x" } });
  // @ts-expect-error /api/sidebar has no DELETE (only /api/sidebar/{entry_id})
  void apiDelete("/api/sidebar", {});
});

typeProbe(() => {
  // @ts-expect-error {title} is a required path parameter
  void apiGet("/api/page/{title}", {});
  // @ts-expect-error /api/current-work takes no path parameters
  void apiGet("/api/current-work", { path: { title: rawTitleOf("T") } });
  // @ts-expect-error bl_limitt is not a query parameter of this route
  void apiGet("/api/page/{title}", { path: { title: rawTitleOf("T") }, query: { bl_limitt: 5 } });
  // @ts-expect-error `uids` is a REQUIRED query parameter of /api/block-refs
  void apiGet("/api/block-refs");
  // @ts-expect-error bl_limit is a number
  void apiGet("/api/page/{title}", { path: { title: rawTitleOf("T") }, query: { bl_limit: "5" } });
});

typeProbe(() => {
  // @ts-expect-error a Headers instance would be dropped by the merge
  void apiGet("/api/current-work", { init: { headers: new Headers() } });
});

typeProbe(() => {
  // @ts-expect-error the field is `title`, not `titel`
  void apiPost("/api/pages", { body: { titel: "T" } });
  // @ts-expect-error POST /api/pages requires a body
  void apiPost("/api/pages");
  // @ts-expect-error GET /api/current-work takes no request body
  void apiGet("/api/current-work", { body: { title: "T" } });
});

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
  await apiGet("/api/page/{title}", { path: { title: rawTitleOf("Work/Q3 plan") } });
  expect(fetchMock.mock.calls[0][0]).toBe("/api/page/Work/Q3%20plan");
});

it("encodes a title containing regexp replacement syntax literally", async () => {
  // "$&" in a String.replace REPLACEMENT means "the whole match"; a title
  // like this used to be able to inject the placeholder back into the URL.
  const fetchMock = stubFetch();
  await apiGet("/api/page/{title}", { path: { title: rawTitleOf("$& $`") } });
  expect(fetchMock.mock.calls[0][0]).toBe("/api/page/%24%26%20%24%60");
});

it("appends supplied query parameters and drops undefined ones", async () => {
  const fetchMock = stubFetch();
  await apiGet("/api/page/{title}",
               { path: { title: rawTitleOf("T") }, query: { bl_limit: 5, bl_offset: undefined } });
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
  expect(fetchMock.mock.calls[0]).toEqual(["/api/current-work", READ_INIT]);
});

it("sends a JSON body with the method the path declares", async () => {
  const fetchMock = stubFetch();
  await apiPost("/api/page/{title}/rename",
                { path: { title: rawTitleOf("Old") }, body: { new_title: rawTitleOf("New"), allow_merge: true } });
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
  await apiPut("/api/sidebar", { body: { order: [sidebarEntryIdOf(3), sidebarEntryIdOf(1)] } });
  expect(fetchMock.mock.calls[0]).toEqual(["/api/sidebar", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ order: [3, 1] }),
  }]);
});

it("sends no body or content type for a bodyless write", async () => {
  const fetchMock = stubFetch();
  await apiDelete("/api/page/{title}", { path: { title: rawTitleOf("T") } });
  expect(fetchMock.mock.calls[0]).toEqual(["/api/page/T", { method: "DELETE" }]);
});

it("passes extra init through and lets the caller's headers win", async () => {
  const fetchMock = stubFetch();
  const signal = AbortSignal.abort();
  await apiPost("/api/pages",
                { body: { title: rawTitleOf("T") }, init: { signal, headers: { "X-Test": "1" } } })
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
