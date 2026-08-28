// pattern: Imperative Shell
// iOS standalone home-screen apps open external links in the WKWebView
// in-app browser overlay, not real Safari (no shipped API to change this).
// The undocumented x-safari-http(s) scheme (iOS 17+) hands a URL to the real
// Safari app; this component is the only place that reads the real
// `navigator`/`window` and performs the navigation, delegating the actual
// decision to externalLink.ts's pure predicate/transform.
import { useEffect } from "react";
import { isIosStandalone, safariHrefForClick } from "../externalLink";

function defaultNavigate(url: string) {
  window.location.assign(url);
}

export function ExternalLinkInterceptor({ navigate = defaultNavigate }: {
  navigate?: (url: string) => void;
} = {}) {
  useEffect(() => {
    if (!isIosStandalone(window.navigator)) return;

    const handler = (e: MouseEvent) => {
      if (e.defaultPrevented) return;
      const anchor = (e.target as Element | null)?.closest?.("a[href]");
      if (!anchor) return;

      const safariHref = safariHrefForClick(
        (anchor as HTMLAnchorElement).href,
        window.location.origin,
        { button: e.button, metaKey: e.metaKey, ctrlKey: e.ctrlKey,
          shiftKey: e.shiftKey, altKey: e.altKey },
      );
      if (safariHref === null) return;

      e.preventDefault();
      navigate(safariHref);
    };

    document.addEventListener("click", handler, { capture: true });
    return () => document.removeEventListener("click", handler, { capture: true });
  }, [navigate]);

  return null;
}
