// pattern: Imperative Shell
import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { routeMetaFor } from "./routeMeta";

/** Sets document.title from the centralized route table (pkm-77w2),
 * replacing five near-identical per-view effects. /page/* has no entry in
 * that table on purpose: PageView.tsx keeps its own effect, setting the
 * title once the loaded page's own title is known. The not-found catch-all
 * also has no entry, so its title is left as whatever the previous route
 * set -- matching its prior (never explicitly set) behaviour. */
export function useRouteTitle(): void {
  const { pathname } = useLocation();
  useEffect(() => {
    const meta = routeMetaFor(pathname);
    if (meta) document.title = meta.title;
  }, [pathname]);
}
