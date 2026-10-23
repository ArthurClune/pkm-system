import { expect, it } from "vitest";
import { externalImageLabel, isUploadedAsset } from "./externalMedia";

it("treats only /assets/ paths as uploaded", () => {
  expect(isUploadedAsset("/assets/a/b.png")).toBe(true);
  for (const src of ["https://h.test/assets/a.png", "//evil.test/assets/x.png",
    "/assetsx/y.png", "assets/a.png", "data:image/png;base64,AA", "blob:x"]) {
    expect(isUploadedAsset(src)).toBe(false);
  }
});

it("labels an external image by host and alt", () => {
  expect(externalImageLabel("https://attacker.invalid/c?q=1", "cite"))
    .toBe("image from attacker.invalid: cite");
  expect(externalImageLabel("https://h.test:8080/x.png", ""))
    .toBe("image from h.test:8080");
});

it("falls back to 'external image' without a parsable host", () => {
  expect(externalImageLabel("not a url", "a")).toBe("external image: a");
  expect(externalImageLabel("data:image/png;base64,AAAA", "")).toBe("external image");
  expect(externalImageLabel("//evil.test/x.png", "")).toBe("external image");
});
