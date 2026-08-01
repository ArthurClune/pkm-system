// pattern: Functional Core
// Single source for the app's route paths, top-bar labels, and browser
// titles (pkm-77w2). Previously the router (App.tsx), TopBar, and five
// near-identical per-view effects each hardcoded their own copy of this --
// /files and /settings had fallen through the cracks and had no top-bar
// label at all.

/** Prefix shared by /page/* route matching (TopBar's page-action menu) and
 * page link construction (paths.ts's pagePath). */
export const PAGE_ROUTE_PREFIX = "/page/";

/** Every path App.tsx declares in its <Routes>, so the router and the
 * consistency check below can't drift apart. */
export const ROUTES = {
  journal: "/",
  currentWork: "/current-work",
  page: `${PAGE_ROUTE_PREFIX}*`,
  help: "/help",
  files: "/files",
  settings: "/settings",
  notFound: "*",
} as const;

export interface RouteMeta {
  /** Top-bar label (TopBar.tsx). */
  label: string;
  /** Browser <title>. May differ from the label -- e.g. /help's top-bar
   * label is "Help" but its title is "Keyboard shortcuts — pkm". */
  title: string;
}

/** Label and title for every route whose value is a fixed string.
 * ROUTES.page and ROUTES.notFound are deliberately absent: their label/title
 * depend on data resolved after the route matches (the loaded page's own
 * title; nothing, for not-found) rather than the pathname alone -- see
 * DYNAMIC_ROUTES, which the consistency test checks this table against so a
 * newly declared route can't silently end up with neither. */
export const ROUTE_META: Readonly<Record<string, RouteMeta>> = {
  [ROUTES.journal]: { label: "Daily Notes", title: "Daily Notes — pkm" },
  [ROUTES.currentWork]: { label: "Current Work", title: "Current Work — pkm" },
  [ROUTES.help]: { label: "Help", title: "Keyboard shortcuts — pkm" },
  [ROUTES.files]: { label: "Files", title: "Files — pkm" },
  [ROUTES.settings]: { label: "Settings", title: "Settings — pkm" },
};

/** Routes intentionally excluded from ROUTE_META (see above). */
export const DYNAMIC_ROUTES: readonly string[] = [ROUTES.page, ROUTES.notFound];

export function routeMetaFor(pathname: string): RouteMeta | undefined {
  return ROUTE_META[pathname];
}
