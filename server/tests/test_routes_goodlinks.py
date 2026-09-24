import sqlite3

from fastapi.testclient import TestClient

from conftest import GL_ID
from pkm.goodlinks import goodlinks_href
from pkm.server.app import create_app


def resolve(client, url, save=False):
    return client.post("/api/goodlinks/resolve", json={"url": url, "save": save})


def test_resolve_exact_hit(goodlinks_client, fake_goodlinks):
    r = resolve(goodlinks_client, "https://tratt.net/uml.html")
    assert r.status_code == 200
    assert r.json() == {"id": GL_ID, "title": "UML", "url": "https://tratt.net/uml.html",
                        "added_at": "2022-10-06T15:07:12Z", "created": False}
    assert not any(m == "POST" for m, _ in fake_goodlinks.requests)


def test_resolve_hits_after_stripping_query(goodlinks_client):
    r = resolve(goodlinks_client, "https://tratt.net/uml.html?utm_source=x#frag")
    assert r.status_code == 200
    assert r.json()["id"] == GL_ID


def test_resolve_hits_via_single_search_result(goodlinks_client, fake_goodlinks):
    fake_goodlinks.links[GL_ID]["url"] = "https://tratt.net/uml.html?publication_id=7"
    r = resolve(goodlinks_client, "https://tratt.net/uml.html?utm=1")
    assert r.status_code == 200
    assert r.json()["id"] == GL_ID
    assert r.json()["created"] is False


def test_resolve_finds_a_link_saved_with_the_other_trailing_slash(goodlinks_client, fake_goodlinks):
    fake_goodlinks.links[GL_ID]["url"] = "https://tratt.net/uml.html/"
    r = resolve(goodlinks_client, "https://tratt.net/uml.html")
    assert r.status_code == 200
    body = r.json()
    assert body["id"] == GL_ID
    assert body["created"] is False
    assert not any(m == "POST" for m, _ in fake_goodlinks.requests)


def test_resolve_finds_a_link_saved_without_the_trailing_slash(goodlinks_client, fake_goodlinks):
    r = resolve(goodlinks_client, "https://tratt.net/uml.html/")
    assert r.status_code == 200
    body = r.json()
    assert body["id"] == GL_ID
    assert body["created"] is False
    assert not any(m == "POST" for m, _ in fake_goodlinks.requests)


def test_resolve_miss_without_save_is_404_and_never_posts(goodlinks_client, fake_goodlinks):
    r = resolve(goodlinks_client, "https://nowhere.example/p")
    assert r.status_code == 404
    assert r.json() == {"detail": "not in Goodlinks"}
    assert not any(m == "POST" for m, _ in fake_goodlinks.requests)


def test_resolve_miss_with_save_creates_read_link(goodlinks_client, fake_goodlinks):
    r = resolve(goodlinks_client, "https://nowhere.example/p", save=True)
    assert r.status_code == 200
    body = r.json()
    assert body["created"] is True
    assert body["id"] == "f" * 32
    assert ("POST-BODY", '{"read": true, "url": "https://nowhere.example/p"}') in fake_goodlinks.requests


def test_resolve_save_never_bumps_an_existing_link(goodlinks_client, fake_goodlinks):
    r = resolve(goodlinks_client, "https://tratt.net/uml.html", save=True)
    assert r.json()["created"] is False
    assert not any(m == "POST" for m, _ in fake_goodlinks.requests)


def test_resolve_rejected_save_is_422_with_goodlinks_text(goodlinks_client, fake_goodlinks):
    fake_goodlinks.reject_save = "Invalid URL"
    r = resolve(goodlinks_client, "https://nowhere.example/p", save=True)
    assert r.status_code == 422
    assert r.json() == {"detail": "Invalid URL"}


def test_resolve_when_goodlinks_down_is_503(goodlinks_client, fake_goodlinks):
    fake_goodlinks.down = True
    r = resolve(goodlinks_client, "https://tratt.net/uml.html")
    assert r.status_code == 503
    assert r.json() == {"detail": "Goodlinks is not running on the host"}


def test_resolve_rejects_empty_url(goodlinks_client):
    assert resolve(goodlinks_client, "").status_code == 422


def test_article_returns_sanitised_html_and_no_store(goodlinks_client):
    r = goodlinks_client.get(f"/api/goodlinks/{GL_ID}")
    assert r.status_code == 200
    assert r.headers["cache-control"] == "private, no-store"
    body = r.json()
    assert body["id"] == GL_ID
    assert body["title"] == "UML"
    assert body["url"] == "https://tratt.net/uml.html"
    assert body["added_at"] == "2022-10-06T15:07:12Z"
    assert "<script" not in body["html"]
    assert "alert(" not in body["html"]
    assert 'href="https://x.example"' in body["html"]
    assert 'target="_blank"' in body["html"]


def test_article_tolerates_missing_title_and_date(goodlinks_client, fake_goodlinks):
    fake_goodlinks.links[GL_ID] = {"id": GL_ID, "url": "https://tratt.net/uml.html", "title": None}
    r = goodlinks_client.get(f"/api/goodlinks/{GL_ID}")
    assert r.status_code == 200
    assert r.json()["title"] == ""
    assert r.json()["added_at"] == ""


def test_article_without_content_returns_meta_and_empty_html(goodlinks_client, fake_goodlinks):
    other = "a" * 32
    fake_goodlinks.links[other] = {"id": other, "url": "https://paywall.example/p", "title": "Paywalled",
                                   "addedAt": "2025-02-13T12:00:00Z"}
    r = goodlinks_client.get(f"/api/goodlinks/{other}")
    assert r.status_code == 200
    assert r.headers["cache-control"] == "private, no-store"
    body = r.json()
    assert body["html"] == ""
    assert body["title"] == "Paywalled"
    assert body["url"] == "https://paywall.example/p"


def test_article_unknown_id_is_404(goodlinks_client):
    assert goodlinks_client.get("/api/goodlinks/" + "0" * 32).status_code == 404


def test_article_bad_id_shape_is_404_without_calling_goodlinks(goodlinks_client, fake_goodlinks):
    assert goodlinks_client.get("/api/goodlinks/not-an-id").status_code == 404
    assert goodlinks_client.get("/api/goodlinks/" + GL_ID.upper()).status_code == 404
    assert fake_goodlinks.requests == []


def test_article_when_goodlinks_down_is_503(goodlinks_client, fake_goodlinks):
    fake_goodlinks.down = True
    r = goodlinks_client.get(f"/api/goodlinks/{GL_ID}")
    assert r.status_code == 503


def test_disabled_without_key(client):
    assert client.get(f"/api/goodlinks/{GL_ID}").status_code == 404
    assert client.post("/api/goodlinks/resolve", json={"url": "https://x.example"}).status_code == 404
    r = client.get("/api/goodlinks/check")
    assert r.status_code == 200
    assert r.json() == {"enabled": False, "total": 0, "ok": 0, "problems": []}


def test_requires_auth(seeded_config):
    anon = TestClient(create_app(seeded_config))
    assert anon.get(f"/api/goodlinks/{GL_ID}").status_code == 401
    assert anon.get("/api/goodlinks/check").status_code == 401
    assert anon.post("/api/goodlinks/resolve", json={"url": "x"}).status_code == 401


def _seed_goodlinks_links(db_path):
    con = sqlite3.connect(db_path)
    rows = [
        ("uid_g1", 1, None, 10, f"Local copy:: [Goodlinks]({goodlinks_href(GL_ID)})"),
        ("uid_g2", 1, None, 11, f"Local copy:: [Goodlinks]({goodlinks_href('0' * 32)})"),
        ("uid_g3", 2, None, 10, "see /api/goodlinks/not-hex and [dup](" + goodlinks_href(GL_ID) + ")"),
        ("uid_g4", 2, None, 11, "no goodlinks here"),
    ]
    con.executemany(
        "INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text, heading,"
        " collapsed, created_at, updated_at) VALUES (?,?,?,?,?,NULL,0,NULL,NULL)", rows)
    con.commit()
    con.close()


def test_check_classifies_every_href(goodlinks_client, seeded_config, fake_goodlinks):
    _seed_goodlinks_links(seeded_config.db_path)
    r = goodlinks_client.get("/api/goodlinks/check")
    assert r.status_code == 200
    body = r.json()
    assert body["enabled"] is True
    assert body["total"] == 4
    assert body["ok"] == 2
    assert sorted((p["uid"], p["status"]) for p in body["problems"]) == [
        ("uid_g2", "missing"), ("uid_g3", "invalid")]
    by_uid = {p["uid"]: p for p in body["problems"]}
    assert by_uid["uid_g2"]["page"] == "Machine Learning"
    assert by_uid["uid_g3"]["href"] == "/api/goodlinks/not-hex"
    # the same id appearing twice is asked of GoodLinks once
    gets = [u for m, u in fake_goodlinks.requests if m == "GET" and u.endswith(GL_ID)]
    assert len(gets) == 1


def test_check_when_goodlinks_down_is_503(goodlinks_client, seeded_config, fake_goodlinks):
    _seed_goodlinks_links(seeded_config.db_path)
    fake_goodlinks.down = True
    assert goodlinks_client.get("/api/goodlinks/check").status_code == 503


def test_check_is_not_taken_as_an_id(goodlinks_client, fake_goodlinks):
    assert goodlinks_client.get("/api/goodlinks/check").json()["enabled"] is True
    assert fake_goodlinks.requests == []


_UNAUTHORIZED = {"detail": "Goodlinks rejected the API token"}


def test_resolve_with_a_wrong_token_is_503_naming_the_token(goodlinks_client, fake_goodlinks):
    fake_goodlinks.unauthorized = True
    r = resolve(goodlinks_client, "https://tratt.net/uml.html", save=True)
    assert r.status_code == 503
    assert r.json() == _UNAUTHORIZED


def test_article_with_a_wrong_token_is_503_naming_the_token(goodlinks_client, fake_goodlinks):
    fake_goodlinks.unauthorized = True
    r = goodlinks_client.get(f"/api/goodlinks/{GL_ID}")
    assert r.status_code == 503
    assert r.json() == _UNAUTHORIZED


def test_check_with_a_wrong_token_is_503_naming_the_token(goodlinks_client, seeded_config, fake_goodlinks):
    _seed_goodlinks_links(seeded_config.db_path)
    fake_goodlinks.unauthorized = True
    r = goodlinks_client.get("/api/goodlinks/check")
    assert r.status_code == 503
    assert r.json() == _UNAUTHORIZED
