import { describe, expect, it } from "vitest";
import { DYNAMIC_ROUTES, PAGE_ROUTE_PREFIX, ROUTE_META, ROUTES, routeMetaFor } from "./routeMeta";

describe("ROUTES / ROUTE_META consistency", () => {
  it("every declared route has a label/title entry or is an explicit dynamic marker, never both", () => {
    for (const path of Object.values(ROUTES)) {
      const hasMeta = path in ROUTE_META;
      const isDynamic = DYNAMIC_ROUTES.includes(path);
      expect(hasMeta || isDynamic).toBe(true);
      expect(hasMeta && isDynamic).toBe(false);
    }
  });

  it("the page route is built from the shared page-route prefix", () => {
    expect(ROUTES.page).toBe(`${PAGE_ROUTE_PREFIX}*`);
  });
});

describe("routeMetaFor", () => {
  it.each([
    ["/files/", { label: "Files", title: "Files — pkm" }],
    ["/settings///", { label: "Settings", title: "Settings — pkm" }],
  ])("normalizes trailing slashes for static route %s", (pathname, expected) => {
    expect(routeMetaFor(pathname)).toEqual(expected);
  });

  it("keeps root canonical and dynamic/unmatched paths undefined", () => {
    expect(routeMetaFor("/")).toEqual(ROUTE_META[ROUTES.journal]);
    expect(routeMetaFor("/page/Paper/")).toBeUndefined();
    expect(routeMetaFor("/definitely/not/a/route/")).toBeUndefined();
  });

  it("a route's label and title may differ (Help's browser title isn't its top-bar label)", () => {
    expect(routeMetaFor(ROUTES.help)).toEqual({
      label: "Help",
      title: "Keyboard shortcuts — pkm",
    });
  });
});
