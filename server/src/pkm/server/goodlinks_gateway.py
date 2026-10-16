# pattern: Imperative Shell
"""The HTTP edge to the GoodLinks app's local API (bearer token, one
port on the host). Every method returns plain dicts or text; the pure
decisions about them live in pkm.goodlinks. Three failure classes matter
to callers: GoodLinks not answering (the app is not running, it
returned 5xx, or a 2xx response body was not a JSON object), GoodLinks
refusing the API token (401 or 403 on any request), and GoodLinks
refusing a save (any other 4xx on POST). A 404 on a read is an ordinary
"not there" and comes back as None."""
from __future__ import annotations

from collections.abc import Mapping

import httpx2

from pkm.goodlinks import GoodlinksId


class GoodlinksUnavailable(Exception):
    """GoodLinks did not answer, or answered with a server error."""


class GoodlinksUnauthorized(Exception):
    """GoodLinks refused the API token (401 or 403)."""


class GoodlinksRejected(Exception):
    """GoodLinks refused a write (4xx on POST /links)."""

    def __init__(self, status: int, detail: str) -> None:
        super().__init__(f"goodlinks rejected the request: {status} {detail}")
        self.status = status
        self.detail = detail


def _json(r: httpx2.Response) -> dict[str, object]:
    try:
        body: object = r.json()
    except ValueError as e:
        raise GoodlinksUnavailable(f"goodlinks answered with a non-JSON body: {e}") from e
    if not isinstance(body, dict):
        raise GoodlinksUnavailable(f"goodlinks answered with a JSON {type(body).__name__}, not an object")
    return body


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

    def _request(self, method: str, path: str, *,
                 params: Mapping[str, str] | None = None,
                 json: Mapping[str, object] | None = None) -> httpx2.Response:
        try:
            r = self._http.request(method, path, headers=self._headers,
                                   params=params, json=json)
        except httpx2.TransportError as e:
            raise GoodlinksUnavailable(str(e)) from e
        if r.status_code >= 500:
            raise GoodlinksUnavailable(f"goodlinks answered {r.status_code}")
        if r.status_code in (401, 403):
            raise GoodlinksUnauthorized(f"goodlinks answered {r.status_code}")
        return r

    def _read(self, path: str, *,
              params: Mapping[str, str] | None = None) -> httpx2.Response | None:
        r = self._request("GET", path, params=params)
        if r.status_code == 404:
            return None
        if r.status_code >= 400:
            raise GoodlinksUnavailable(f"goodlinks answered {r.status_code}")
        return r

    def lookup(self, url: str) -> dict[str, object] | None:
        r = self._read("/links", params={"url": url})
        return _json(r) if r is not None else None

    def search(self, query: str, limit: int = 5) -> list[dict[str, object]]:
        r = self._read("/links", params={"search": query, "limit": str(limit)})
        if r is None:
            return []
        data = _json(r).get("data", [])
        if not isinstance(data, list):
            return []
        return [item for item in data if isinstance(item, dict)]

    def save(self, url: str) -> dict[str, object]:
        r = self._request("POST", "/links", json={"url": url, "read": True})
        if r.status_code >= 400:
            raise GoodlinksRejected(r.status_code, _error_detail(r))
        return _json(r)

    def link(self, link_id: GoodlinksId) -> dict[str, object] | None:
        r = self._read(f"/links/{link_id}")
        return _json(r) if r is not None else None

    def content(self, link_id: GoodlinksId) -> str | None:
        r = self._read(f"/links/{link_id}/content", params={"format": "html"})
        return r.text if r is not None else None
