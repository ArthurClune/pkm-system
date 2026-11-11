import { describe, expect, it } from "vitest";
import { documentTitleFor, NOT_FOUND_TITLE, ROUTES, routeMetaFor,
         STATIC_ROUTES } from "./routeMeta";

describe("routeMetaFor", () => {
  it.each([
    ["/files/", "Files", "Files — pkm"],
    ["/settings///", "Settings", "Settings — pkm"],
  ])("normalizes trailing slashes for static route %s",
     (pathname, label, documentTitle) => {
    expect(routeMetaFor(pathname))
      .toMatchObject({ label, documentTitle });
  });

  it("keeps root canonical and dynamic/unmatched paths undefined", () => {
    expect(routeMetaFor("/")).toMatchObject({ path: ROUTES.journal });
    expect(routeMetaFor("/page/Paper/")).toBeUndefined();
    expect(routeMetaFor("/definitely/not/a/route/")).toBeUndefined();
  });

  it("a route's label and title may differ (Help's browser title isn't its top-bar label)", () => {
    expect(routeMetaFor(ROUTES.help)).toMatchObject({
      label: "Help",
      documentTitle: "Keyboard shortcuts — pkm",
    });
  });
});

it("documentTitleFor gives a static route's title, null under /page/, and "
   + "the not-found title elsewhere", () => {
  expect(documentTitleFor("/settings/")).toBe("Settings — pkm");
  expect(documentTitleFor("/page/Paper")).toBeNull();
  expect(documentTitleFor("/nope")).toBe(NOT_FOUND_TITLE);
});

it("static routes have distinct ids and paths", () => {
  const ids = STATIC_ROUTES.map((r) => r.id);
  const paths = STATIC_ROUTES.map((r) => r.path);
  expect(new Set(ids).size).toBe(ids.length);
  expect(new Set(paths).size).toBe(paths.length);
});

it("ROUTES maps each static route's id to its path", () => {
  for (const r of STATIC_ROUTES) expect(ROUTES[r.id]).toBe(r.path);
  expect(Object.keys(ROUTES)).toHaveLength(STATIC_ROUTES.length);
});
