// pattern: Functional Core
// Deciding whether/how to rewrite an external-link click into Safari's
// undocumented x-safari-http(s) scheme is pure: given a navigator-shaped
// object and a click's href/modifiers, it either returns a URL string or
// null. All reads of the real `navigator`/`window` and the actual
// preventDefault/navigate side effects live in the Imperative Shell
// (ExternalLinkInterceptor.tsx) that calls this.

/** The subset of `Navigator` this module reads, so callers (and tests) can
 * pass a plain object instead of the real global. */
export interface NavigatorLike {
  platform: string;
  maxTouchPoints: number;
  /** Only ever set (and only ever `true`) on iOS Safari/WebKit; absent
   * everywhere else, including desktop Safari. */
  standalone?: boolean;
}

export interface ClickModifiers {
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

const IOS_PLATFORM_RE = /iP(hone|ad|od)/;

/** True only when running as an installed iOS/iPadOS home-screen app.
 * Modern iPadOS reports `platform: "MacIntel"` like a real Mac, so it's
 * distinguished by touch support (`maxTouchPoints > 1`); requiring BOTH the
 * iOS-family platform check (or the iPad/Mac disambiguator) AND
 * `standalone === true` avoids matching macOS "Add to Dock" web apps, which
 * never set `navigator.standalone`. */
export function isIosStandalone(nav: NavigatorLike): boolean {
  const isIosFamily = IOS_PLATFORM_RE.test(nav.platform)
    || (nav.platform === "MacIntel" && nav.maxTouchPoints > 1);
  return isIosFamily && nav.standalone === true;
}

/** Given the anchor's resolved href and the click's modifiers, decide the
 * x-safari-http(s) URL to navigate to instead, or null when the click
 * should be left alone (not http/https, same-origin, unparseable, or a
 * modified/non-primary click the browser must handle natively — new tab,
 * context menu, etc). */
export function safariHrefForClick(href: string, currentOrigin: string,
                                    modifiers: ClickModifiers): string | null {
  if (modifiers.button !== 0) return null;
  if (modifiers.metaKey || modifiers.ctrlKey || modifiers.shiftKey || modifiers.altKey) {
    return null;
  }

  let url: URL;
  try {
    url = new URL(href, currentOrigin);
  } catch {
    return null;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.origin === currentOrigin) return null;

  return url.href.replace(/^https?:/, (scheme) => `x-safari-${scheme}`);
}
