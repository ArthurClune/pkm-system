// pattern: Functional Core
// Single source for the app's route paths, top-bar labels and browser
// titles. App.tsx maps STATIC_ROUTES to its views; TopBar and useRouteTitle
// read the labels and titles from here.

/** Prefix shared by /page/* route matching (MainRoutes, TopBar's page-action
 * menu) and page paths (paths.ts). */
export const PAGE_ROUTE_PREFIX = "/page/";

export interface StaticRoute {
  id: string;
  path: string;
  /** Top-bar label (TopBar.tsx). */
  label: string;
  /** Browser <title>. May differ from the label: /help's top-bar label is
   * "Help", its title "Keyboard shortcuts — pkm". */
  documentTitle: string;
}

/** Every route whose label and title are fixed strings. A /page/ route's
 * come from the loaded page; any other path is not found. */
export const STATIC_ROUTES = [
  { id: "journal", path: "/", label: "Daily Notes",
    documentTitle: "Daily Notes — pkm" },
  { id: "currentWork", path: "/current-work", label: "Current Work",
    documentTitle: "Current Work — pkm" },
  { id: "help", path: "/help", label: "Help",
    documentTitle: "Keyboard shortcuts — pkm" },
  { id: "files", path: "/files", label: "Files",
    documentTitle: "Files — pkm" },
  { id: "settings", path: "/settings", label: "Settings",
    documentTitle: "Settings — pkm" },
] as const satisfies readonly StaticRoute[];

export type StaticRouteId = (typeof STATIC_ROUTES)[number]["id"];

export const ROUTES = Object.fromEntries(
  STATIC_ROUTES.map((r) => [r.id, r.path]),
) as { readonly [K in StaticRouteId]: string };

export const NOT_FOUND_TITLE = "Page not found — pkm";

/** The router matches paths case-insensitively, so this does too: /Files
 * renders the Files view and must title it as such. */
export function routeMetaFor(pathname: string): StaticRoute | undefined {
  const canonical = (pathname === "/" ? pathname : pathname.replace(/\/+$/, ""))
    .toLowerCase();
  return STATIC_ROUTES.find((r) => r.path === canonical);
}

/** null under PAGE_ROUTE_PREFIX: PageView sets its own title. */
export function documentTitleFor(pathname: string): string | null {
  if (pathname.toLowerCase().startsWith(PAGE_ROUTE_PREFIX)) return null;
  return routeMetaFor(pathname)?.documentTitle ?? NOT_FOUND_TITLE;
}
