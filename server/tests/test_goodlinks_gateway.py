import json

import httpx2
import pytest

from pkm.server.goodlinks_gateway import (GoodlinksGateway, GoodlinksRejected,
                                          GoodlinksUnauthorized, GoodlinksUnavailable)

BASE = "http://goodlinks.test/api/v1"
ID = "e4966bb2483b5c78f658398c0ae7b03f"
LINK = {"id": ID, "url": "https://a.example/p", "title": "A", "addedAt": "2025-02-13T19:51:00Z"}


def gateway(handler) -> GoodlinksGateway:
    http = httpx2.Client(transport=httpx2.MockTransport(handler), base_url=BASE)
    return GoodlinksGateway(BASE, "tok", http=http)


def test_lookup_sends_bearer_and_decodes_hit():
    seen = {}

    def handler(req: httpx2.Request) -> httpx2.Response:
        seen["auth"] = req.headers.get("authorization")
        seen["url"] = str(req.url)
        return httpx2.Response(200, json=LINK)

    assert gateway(handler).lookup("https://a.example/p") == LINK
    assert seen["auth"] == "Bearer tok"
    assert seen["url"] == f"{BASE}/links?url=https%3A%2F%2Fa.example%2Fp"


def test_lookup_404_is_none():
    assert gateway(lambda r: httpx2.Response(404, json={"error": "Not Found"})).lookup("x") is None


def test_search_returns_data_list():
    def handler(req):
        assert req.url.params["search"] == "a.example/p"
        assert req.url.params["limit"] == "5"
        return httpx2.Response(200, json={"data": [LINK], "hasMore": False})

    assert gateway(handler).search("a.example/p") == [LINK]


def test_save_posts_url_read_true_and_returns_link():
    seen = {}

    def handler(req):
        seen["method"] = req.method
        seen["body"] = json.loads(req.content)
        return httpx2.Response(200, json=LINK)

    assert gateway(handler).save("https://a.example/p") == LINK
    assert seen == {"method": "POST", "body": {"url": "https://a.example/p", "read": True}}


def test_save_4xx_raises_rejected_with_detail():
    gw = gateway(lambda r: httpx2.Response(400, json={"error": "Invalid URL"}))
    with pytest.raises(GoodlinksRejected) as e:
        gw.save("nope")
    assert e.value.status == 400
    assert e.value.detail == "Invalid URL"


def test_link_and_content():
    def handler(req):
        if req.url.path.endswith("/content"):
            assert req.url.params["format"] == "html"
            return httpx2.Response(200, text="<p>hi</p>", headers={"content-type": "text/html"})
        return httpx2.Response(200, json=LINK)

    gw = gateway(handler)
    assert gw.link(ID) == LINK
    assert gw.content(ID) == "<p>hi</p>"


def test_link_and_content_404_are_none():
    gw = gateway(lambda r: httpx2.Response(404, json={"error": "Not Found"}))
    assert gw.link(ID) is None
    assert gw.content(ID) is None


def test_transport_error_is_unavailable():
    def handler(req):
        raise httpx2.ConnectError("refused")

    with pytest.raises(GoodlinksUnavailable):
        gateway(handler).lookup("x")


def test_5xx_is_unavailable():
    with pytest.raises(GoodlinksUnavailable):
        gateway(lambda r: httpx2.Response(500, text="boom")).link(ID)


def test_401_on_a_read_is_unauthorized():
    with pytest.raises(GoodlinksUnauthorized):
        gateway(lambda r: httpx2.Response(401, json={"error": "Unauthorized"})).lookup("x")


def test_403_on_save_is_unauthorized_not_rejected():
    with pytest.raises(GoodlinksUnauthorized):
        gateway(lambda r: httpx2.Response(403, json={"error": "Forbidden"})).save("https://a.example/p")


def test_lookup_non_json_2xx_body_is_unavailable():
    with pytest.raises(GoodlinksUnavailable):
        gateway(lambda r: httpx2.Response(200, text="not json")).lookup("x")


def test_search_non_json_2xx_body_is_unavailable():
    with pytest.raises(GoodlinksUnavailable):
        gateway(lambda r: httpx2.Response(200, text="not json")).search("x")


def test_save_non_json_2xx_body_is_unavailable():
    with pytest.raises(GoodlinksUnavailable):
        gateway(lambda r: httpx2.Response(200, text="not json")).save("https://a.example/p")


def test_link_non_json_2xx_body_is_unavailable():
    with pytest.raises(GoodlinksUnavailable):
        gateway(lambda r: httpx2.Response(200, text="not json")).link(ID)
