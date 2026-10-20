import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { block, canonicalTitleOf, jsonResponse, pagePayload } from "../test-helpers";
import type { RawTitle } from "../api/brands";
import { substituteMissingDaily } from "./missingPage";
import { isOutlineSessionActive } from "./outlineSessions";
import { useOutlinePageLoad } from "./useOutlinePageLoad";

afterEach(() => vi.unstubAllGlobals());

const raw = (t: string) => t as RawTitle;
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
      () => useOutlinePageLoad(raw("Paper"), () => null));
    await waitFor(() => expect(result.current.payload).not.toBeNull());
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(isOutlineSessionActive("Paper")).toBe(true);
    unmount();
  });

  it("a padded title costs one extra GET and keeps only the canonical session",
     async () => {
       const fetchMock = stub(() => jsonResponse(
         pagePayload(canonicalTitleOf("Paper"), [block("tuid-u1", "first")])));
       const { result, unmount } = renderHook(
         () => useOutlinePageLoad(raw("Paper "), () => null));
       await waitFor(() => expect(result.current.payload).not.toBeNull());
       await settle();
       expect(fetchMock).toHaveBeenCalledTimes(2);
       expect(String(fetchMock.mock.calls[0][0])).toBe("/api/page/Paper%20");
       expect(String(fetchMock.mock.calls[1][0])).toBe("/api/page/Paper");
       expect(isOutlineSessionActive("Paper")).toBe(true);
       expect(isOutlineSessionActive("Paper ")).toBe(false);
       expect(result.current.payload?.page.title).toBe("Paper");
       unmount();
       expect(isOutlineSessionActive("Paper")).toBe(false);
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
         () => useOutlinePageLoad(raw("Paper "), () => null));
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
         () => useOutlinePageLoad(raw("July 13th, 2026"),
                                  substituteMissingDaily));
       await waitFor(() => expect(result.current.payload).not.toBeNull());
       await settle();
       expect(result.current.error).toBeNull();
       expect(fetchMock).toHaveBeenCalledTimes(1);
       expect(isOutlineSessionActive("July 13th, 2026")).toBe(true);
       unmount();
     });

  it("a padded missing daily is not a daily title: it fails, with no re-key loop",
     async () => {
       const fetchMock = stub(() => new Response("{}", { status: 404 }));
       const { result, unmount } = renderHook(
         () => useOutlinePageLoad(raw("July 13th, 2026 "),
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
