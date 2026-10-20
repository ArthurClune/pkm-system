import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { block, canonicalTitleOf, jsonResponse, pagePayload,
         rawTitleOf } from "../test-helpers";
import { substituteMissingDaily } from "./missingPage";
import { isOutlineSessionActive } from "./outlineSessions";
import { useOutlinePageLoad } from "./useOutlinePageLoad";

afterEach(() => vi.unstubAllGlobals());

const settle = () => new Promise((r) => setTimeout(r, 30));

function stub(handler: (url: string) => Response) {
  const fetchMock = vi.fn((input: RequestInfo | URL) =>
    Promise.resolve(handler(String(input))));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("useOutlinePageLoad session key", () => {
  it("a canonical title costs one GET", async () => {
    const fetchMock = stub(() => jsonResponse(
      pagePayload(canonicalTitleOf("Paper"), [block("tuid-u1", "first")])));
    const { result, unmount } = renderHook(
      () => useOutlinePageLoad(rawTitleOf("Paper"), () => null));
    await waitFor(() => expect(result.current.payload).not.toBeNull());
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(isOutlineSessionActive(rawTitleOf("Paper"))).toBe(true);
    unmount();
  });

  it("a padded title costs one extra GET and keeps only the canonical session",
     async () => {
       const fetchMock = stub(() => jsonResponse(
         pagePayload(canonicalTitleOf("Paper"), [block("tuid-u1", "first")])));
       const { result, unmount } = renderHook(
         () => useOutlinePageLoad(rawTitleOf("Paper "), () => null));
       await waitFor(() => expect(result.current.payload).not.toBeNull());
       await settle();
       expect(fetchMock).toHaveBeenCalledTimes(2);
       expect(String(fetchMock.mock.calls[0][0])).toBe("/api/page/Paper%20");
       expect(String(fetchMock.mock.calls[1][0])).toBe("/api/page/Paper");
       expect(isOutlineSessionActive(rawTitleOf("Paper"))).toBe(true);
       expect(isOutlineSessionActive(rawTitleOf("Paper "))).toBe(false);
       expect(result.current.payload?.page.title).toBe("Paper");
       unmount();
       expect(isOutlineSessionActive(rawTitleOf("Paper"))).toBe(false);
     });

  it("a resync read of a padded title re-keys before publishing",
     async () => {
       const page = () => jsonResponse(pagePayload(
         canonicalTitleOf("Paper"), [block("tuid-u1", "first")]));
       const held: Array<(r: Response) => void> = [];
       const fetchMock = vi.fn((_input: RequestInfo | URL) => new Promise<Response>((done) => {
         held.push(done);
       }));
       vi.stubGlobal("fetch", fetchMock);
       const { result, unmount } = renderHook(
         () => useOutlinePageLoad(rawTitleOf("Paper "), () => null));
       await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
       act(() => result.current.reload("resync"));
       await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
       await act(async () => { held[1](page()); await settle(); });
       await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
       const urls = fetchMock.mock.calls.map((c) => String(c[0]));
       expect(urls[2]).toBe("/api/page/Paper");
       expect(result.current.payload).toBeNull();
       expect(isOutlineSessionActive(rawTitleOf("Paper "))).toBe(false);
       await act(async () => { held[2](page()); await settle(); });
       expect(result.current.payload?.page.title).toBe("Paper");
       expect(isOutlineSessionActive(rawTitleOf("Paper"))).toBe(true);
       unmount();
     });

  it("a rename after the re-key is accepted as is: no second re-key",
     async () => {
       let n = 0;
       const fetchMock = stub(() => {
         n += 1;
         return jsonResponse(pagePayload(
           canonicalTitleOf(n === 1 ? "Paper" : `Renamed${n}`),
           [block("tuid-u1", "first")]));
       });
       const { result, unmount } = renderHook(
         () => useOutlinePageLoad(rawTitleOf("Paper "), () => null));
       await waitFor(() => expect(result.current.payload).not.toBeNull());
       await settle();
       expect(fetchMock).toHaveBeenCalledTimes(2);
       expect(result.current.payload?.page.title).toBe("Renamed2");
       unmount();
     });

  it("a missing daily renders empty under its own key after one GET",
     async () => {
       const fetchMock = stub(() => new Response("{}", { status: 404 }));
       const { result, unmount } = renderHook(
         () => useOutlinePageLoad(rawTitleOf("July 13th, 2026"),
                                  substituteMissingDaily));
       await waitFor(() => expect(result.current.payload).not.toBeNull());
       await settle();
       expect(result.current.error).toBeNull();
       expect(fetchMock).toHaveBeenCalledTimes(1);
       expect(isOutlineSessionActive(rawTitleOf("July 13th, 2026"))).toBe(true);
       unmount();
     });

  it("a padded missing daily is not a daily title: it fails, with no re-key loop",
     async () => {
       const fetchMock = stub(() => new Response("{}", { status: 404 }));
       const { result, unmount } = renderHook(
         () => useOutlinePageLoad(rawTitleOf("July 13th, 2026 "),
                                  substituteMissingDaily));
       await waitFor(() => expect(result.current.error).not.toBeNull());
       await settle();
       expect(result.current.payload).toBeNull();
       // The session retries a failed parent read once; no re-key happens.
       expect(fetchMock).toHaveBeenCalledTimes(2);
       const urls = new Set(fetchMock.mock.calls.map((c) => String(c[0])));
       expect(urls.size).toBe(1);
       unmount();
     });
});
