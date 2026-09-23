# pattern: Functional Core
"""Pure decisions behind the /api/goodlinks routes: what a GoodLinks link
href looks like in block text, which URLs to try when resolving a page
against the GoodLinks library, when a search result counts as a match,
and how third-party reader HTML is reduced to an allowlist before the
web app is allowed to render it. No I/O here; routes_goodlinks.py talks
to GoodLinks and calls in.

`sanitize_article` is the first of two barriers between an article's HTML
and the app; the reader's `<iframe sandbox>` is the second. Nothing may
be added to the allowlists for convenience: a tag or attribute that is
not listed is dropped, and that is the intended behaviour."""
from __future__ import annotations

import re
from urllib.parse import urlsplit, urlunsplit

import nh3  # pyrefly: ignore

GOODLINKS_PREFIX = "/api/goodlinks/"

_ID_RE = re.compile(r"[0-9a-f]{32}")

# `[text](/api/goodlinks/...)` targets and bare `/api/goodlinks/...` tokens,
# the same two shapes local_docs.py extracts for /api/local/.
_HREF_RE = re.compile(r"\]\((/api/goodlinks/[^)\s]+)\)|(?<![\w(])(/api/goodlinks/[^\s)\]]+)")

_ALLOWED_TAGS: set[str] = {
    "p", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "blockquote",
    "pre", "code", "em", "strong", "b", "i", "a", "img", "figure", "figcaption",
    "table", "thead", "tbody", "tr", "th", "td", "br", "hr", "sup", "sub",
}
_ALLOWED_ATTRIBUTES: dict[str, set[str]] = {
    "a": {"href", "title"},
    "img": {"src", "alt"},
    "td": {"colspan", "rowspan"},
    "th": {"colspan", "rowspan"},
    # nh3 keeps a set of generic attributes (lang, title, dir, ...) on every
    # tag unless "*" is given explicitly; an empty set here closes that gap
    # so only the per-tag attributes above ever survive.
    "*": set(),
}
_URL_SCHEMES: set[str] = {"http", "https"}


def is_link_id(value: str) -> bool:
    return _ID_RE.fullmatch(value) is not None


def goodlinks_href(link_id: str) -> str:
    return GOODLINKS_PREFIX + link_id


def link_id_from_href(href: str) -> str | None:
    if not href.startswith(GOODLINKS_PREFIX):
        return None
    link_id = href[len(GOODLINKS_PREFIX):]
    return link_id if is_link_id(link_id) else None


def extract_goodlinks_hrefs(text: str) -> list[str]:
    seen: list[str] = []
    for m in _HREF_RE.finditer(text):
        href = m.group(1) or m.group(2)
        if href not in seen:
            seen.append(href)
    return seen


def candidate_urls(url: str) -> list[str]:
    """The URL as written, then without its query string and fragment when
    that changes anything. Tracking parameters are the usual reason an
    exact lookup misses a page GoodLinks does hold."""
    out = [url]
    parts = urlsplit(url)
    stripped = urlunsplit((parts.scheme, parts.netloc, parts.path, "", ""))
    if stripped != url:
        out.append(stripped)
    return out


def _matches_candidate(url: str, candidate: str) -> bool:
    """`url` matches `candidate` when they are equal, or when `url` is the
    candidate with a `?query` or `#fragment` tacked on. A bare prefix hit
    (`/p` against `/page-two` or `/p/x`) is a different page, not a match."""
    if url == candidate:
        return True
    remainder = url[len(candidate):] if url.startswith(candidate) else ""
    return remainder.startswith("?") or remainder.startswith("#")


def search_match(candidates: list[str], results: list[dict]) -> dict | None:
    """A search result counts only when exactly one result's URL equals a
    candidate, or extends it starting with `?` or `#`. Two hits is
    ambiguity, zero is a miss; the caller never guesses."""
    for candidate in candidates:
        hits = [r for r in results if _matches_candidate(str(r.get("url", "")), candidate)]
        if len(hits) == 1:
            return hits[0]
    return None


def sanitize_article(html: str) -> str:
    """Reduce GoodLinks' reader HTML to the allowlist above. Disallowed tags
    are unwrapped (their text survives) except script and style, whose
    content goes too. URLs outside http(s), and relative or
    protocol-relative URLs, lose their attribute: a relative URL in a
    srcdoc iframe resolves against the app's own origin, so this is not
    just cosmetic. Every anchor opens in a new tab with no referrer."""
    return nh3.clean(
        html,
        tags=_ALLOWED_TAGS,
        attributes=_ALLOWED_ATTRIBUTES,
        url_schemes=_URL_SCHEMES,
        url_relative="deny",
        link_rel="noopener noreferrer",
        set_tag_attribute_values={"a": {"target": "_blank"}},
        strip_comments=True,
    )
