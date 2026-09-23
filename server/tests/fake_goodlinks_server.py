# pattern: Imperative Shell
"""A minimal stand-in for the GoodLinks local API, for the Playwright run
(web/e2e/goodlinks.spec.ts). Implements exactly what routes_goodlinks.py
calls: GET /links?url= and ?search=, POST /links, GET /links/{id} and
GET /links/{id}/content. Runs in a daemon thread beside the e2e app."""
from __future__ import annotations

import hashlib
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

TOKEN = "e2e-goodlinks"
ARTICLE_ID = "0123456789abcdef0123456789abcdef"
ARTICLE_URL = "https://example.com/e2e-article"

LINKS: dict[str, dict] = {
    ARTICLE_ID: {"id": ARTICLE_ID, "url": ARTICLE_URL, "title": "E2E Article",
                 "addedAt": "2025-02-13T12:00:00Z", "readAt": "2025-02-13T19:51:00Z"},
}
HTML: dict[str, str] = {
    ARTICLE_ID: '<div dir="auto"><p>Archived article body for e2e.</p>'
                '<script>document.title="pwned"</script>'
                '<p><a href="https://example.com/next">next</a></p></div>',
}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format: str, *args) -> None:  # noqa: A002 (matches base signature)
        pass  # keep the Playwright output quiet

    def _send(self, status: int, body: bytes, ctype: str = "application/json") -> None:
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _json(self, status: int, obj) -> None:
        self._send(status, json.dumps(obj).encode())

    def _authed(self) -> bool:
        if self.headers.get("Authorization") == f"Bearer {TOKEN}":
            return True
        self._json(401, {"error": "Unauthorized"})
        return False

    def do_GET(self) -> None:  # noqa: N802 (http.server naming)
        if not self._authed():
            return
        parts = urlsplit(self.path)
        q = parse_qs(parts.query)
        if parts.path == "/api/v1/links":
            if "url" in q:
                for link in LINKS.values():
                    if link["url"] == q["url"][0]:
                        return self._json(200, link)
                return self._json(404, {"error": "Not Found"})
            needle = q.get("search", [""])[0]
            hits = [link for link in LINKS.values() if needle and needle in link["url"]]
            return self._json(200, {"data": hits, "hasMore": False})
        if parts.path.startswith("/api/v1/links/") and parts.path.endswith("/content"):
            link_id = parts.path.split("/")[-2]
            html = HTML.get(link_id)
            if html is None:
                return self._json(404, {"error": "Not Found"})
            return self._send(200, html.encode(), "text/html; charset=utf-8")
        if parts.path.startswith("/api/v1/links/"):
            link = LINKS.get(parts.path.split("/")[-1])
            return self._json(200, link) if link else self._json(404, {"error": "Not Found"})
        self._json(404, {"error": "Not Found"})

    def do_POST(self) -> None:  # noqa: N802
        if not self._authed():
            return
        if urlsplit(self.path).path != "/api/v1/links":
            return self._json(404, {"error": "Not Found"})
        length = int(self.headers.get("Content-Length", "0"))
        body = json.loads(self.rfile.read(length) or b"{}")
        url = body.get("url", "")
        if not url.startswith("http"):
            return self._json(400, {"error": "Invalid URL"})
        link_id = hashlib.md5(url.encode()).hexdigest()
        link = LINKS.setdefault(link_id, {"id": link_id, "url": url, "title": f"Saved {url}",
                                          "addedAt": "2026-09-23T10:00:00Z"})
        if body.get("read"):
            link["readAt"] = "2026-09-23T10:00:00Z"
        HTML.setdefault(link_id, f"<p>Fresh copy of {url}</p>")
        self._json(200, link)


def start(port: int) -> ThreadingHTTPServer:
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server
