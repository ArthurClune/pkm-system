# pattern: Imperative Shell
"""The HTTP edge to the GoodLinks app's local API (bearer token, one
port on the host). Every method returns plain dicts or text; the pure
decisions about them live in pkm.goodlinks. Two failure classes matter
to callers: GoodLinks not answering (the app is not running, or it
returned 5xx) and GoodLinks refusing a save (4xx on POST). A 404 on a
read is an ordinary "not there" and comes back as None."""
from __future__ import annotations

import httpx2


class GoodlinksUnavailable(Exception):
    """GoodLinks did not answer, or answered with a server error."""


class GoodlinksRejected(Exception):
    """GoodLinks refused a write (4xx on POST /links)."""

    def __init__(self, status: int, detail: str) -> None:
        super().__init__(f"goodlinks rejected the request: {status} {detail}")
        self.status = status
        self.detail = detail


def _error_detail(r: httpx2.Response) -> str:
    try:
        body = r.json()
    except ValueError:
        return r.text.strip() or f"status {r.status_code}"
    if isinstance(body, dict) and isinstance(body.get("error"), str):
        return body["error"]
    return f"status {r.status_code}"


class GoodlinksGateway:
    def __init__(self, base_url: str, token: str, http: httpx2.Client | None = None) -> None:
        self._http = http if http is not None else httpx2.Client(base_url=base_url, timeout=10.0)
        self._headers = {"Authorization": f"Bearer {token}"}

    def close(self) -> None:
        self._http.close()

    def _request(self, method: str, path: str, **kw) -> httpx2.Response:
        try:
            r = self._http.request(method, path, headers=self._headers, **kw)
        except httpx2.TransportError as e:
            raise GoodlinksUnavailable(str(e)) from e
        if r.status_code >= 500:
            raise GoodlinksUnavailable(f"goodlinks answered {r.status_code}")
        return r

    def _read(self, path: str, **kw) -> httpx2.Response | None:
        r = self._request("GET", path, **kw)
        if r.status_code == 404:
            return None
        if r.status_code >= 400:
            raise GoodlinksUnavailable(f"goodlinks answered {r.status_code}")
        return r

    def lookup(self, url: str) -> dict | None:
        r = self._read("/links", params={"url": url})
        return r.json() if r is not None else None

    def search(self, query: str, limit: int = 5) -> list[dict]:
        r = self._read("/links", params={"search": query, "limit": str(limit)})
        if r is None:
            return []
        data = r.json().get("data", [])
        return data if isinstance(data, list) else []

    def save(self, url: str) -> dict:
        r = self._request("POST", "/links", json={"url": url, "read": True})
        if r.status_code >= 400:
            raise GoodlinksRejected(r.status_code, _error_detail(r))
        return r.json()

    def link(self, link_id: str) -> dict | None:
        r = self._read(f"/links/{link_id}")
        return r.json() if r is not None else None

    def content(self, link_id: str) -> str | None:
        r = self._read(f"/links/{link_id}/content", params={"format": "html"})
        return r.text if r is not None else None
