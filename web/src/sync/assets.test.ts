import { expect, test, vi } from "vitest";
import { jsonResponse } from "../test-helpers";
import { assetMarkdown, uploadAsset } from "./assets";

const INFO = { sha256: "ab".repeat(32), filename: "cat.png",
               mime: "image/png", size: 3, url: `/assets/${"ab".repeat(32)}/cat.png` };

test("uploadAsset POSTs multipart form data to /api/assets", async () => {
  const mock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    expect(init?.method).toBe("POST");
    expect(init?.body).toBeInstanceOf(FormData);
    expect((init?.body as FormData).get("file")).toBeInstanceOf(File);
    return jsonResponse(INFO);
  });
  vi.stubGlobal("fetch", mock);
  const info = await uploadAsset(new File(["abc"], "cat.png", { type: "image/png" }));
  expect(info).toEqual(INFO);
  expect(mock).toHaveBeenCalledWith("/api/assets", expect.anything());
});

test("assetMarkdown: image embed for images, plain link otherwise", () => {
  expect(assetMarkdown(INFO)).toBe(`![cat.png](${INFO.url})`);
  expect(assetMarkdown({ ...INFO, filename: "doc.pdf", mime: "application/pdf" }))
    .toBe(`[doc.pdf](${INFO.url})`);
});
