// pattern: Imperative Shell
import { useEffect } from "react";
import { useLocation } from "react-router";
import { documentTitleFor } from "./routeMeta";

/** Sets document.title from the route table. Under /page/ the title is left
 * to PageView, which sets it once the loaded page's own title is known. */
export function useRouteTitle(): void {
  const { pathname } = useLocation();
  useEffect(() => {
    const title = documentTitleFor(pathname);
    if (title !== null) document.title = title;
  }, [pathname]);
}
