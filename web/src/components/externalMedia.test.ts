import { expect, it } from "vitest";
import { externalImageLabel, isUploadedAsset } from "./externalMedia";

it("treats only /assets/ paths as uploaded", () => {
  expect(isUploadedAsset("/assets/a/b.png")).toBe(true);
  for (const src of ["https://h.test/assets/a.png", "//evil.test/assets/x.png",
    "/assetsx/y.png", "assets/a.png", "data:image/png;base64,AA", "blob:x"]) {
    expect(isUploadedAsset(src)).toBe(false);
  }
});

it("keeps real asset paths uploaded, dotted filenames included", () => {
  const sha = "3f786850e387550fdab836ed7e6dc881de23001b";
  for (const src of [`/assets/${sha}/photo.png`, `/assets/${sha}/IMG_0868.jpeg`,
    `/assets/${sha}/a.b.c.png`, `/assets/${sha}/a..b.png`, `/assets/${sha}/...png`]) {
    expect(isUploadedAsset(src)).toBe(true);
  }
});

it("treats a path that climbs out of /assets/ as external", () => {
  for (const src of ["/assets/../api/export.zip", "/assets/..%2fapi/x",
    "/assets/%2e%2e/api/x", "/assets\\..\\api/x", "/assets/%2E%2E/x",
    "/assets/.%2e/api/x", "/assets/a\\..\\..\\api/x", "/assets/a%5capi",
    "/assets/a%2F..%2Fapi", "/assets/.\t./api/x", "/assets/..\n/api/x", "/assets/.."]) {
    expect(isUploadedAsset(src)).toBe(false);
  }
});

it("labels an external image by host and alt", () => {
  expect(externalImageLabel("https://attacker.invalid/c?q=1", "cite"))
    .toBe("image from attacker.invalid: cite");
  expect(externalImageLabel("https://h.test:8080/x.png", ""))
    .toBe("image from h.test:8080");
  expect(externalImageLabel("//evil.test/x.png", "")).toBe("image from evil.test");
});

it("falls back to 'external image' without a parsable host", () => {
  expect(externalImageLabel("not a url", "a")).toBe("external image: a");
  expect(externalImageLabel("data:image/png;base64,AAAA", "")).toBe("external image");
});
