import { describe, expect, it } from "vitest";
import { buildStampDefine, buildStampFile } from "./buildStampPlugin";

describe("build stamp", () => {
  it("defines the build's id in a production build", () => {
    expect(buildStampDefine("build", "fixed"))
      .toEqual({ __PKM_BUILD__: JSON.stringify("fixed") });
  });

  it("defines dev under vite serve, so dev and tests never compare", () => {
    expect(buildStampDefine("serve", "fixed"))
      .toEqual({ __PKM_BUILD__: JSON.stringify("dev") });
  });

  it("emits the same id as build-id.json", () => {
    expect(buildStampFile("fixed")).toEqual({
      type: "asset", fileName: "build-id.json", source: '{"build":"fixed"}',
    });
  });
});
