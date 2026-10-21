"""The /assets/<sha>/<name> URL the server returns encodes the name, and
the GET route keeps serving links written with a raw name."""
import hashlib

from conftest import single_decode_get

from pkm.assets_core import asset_label, asset_url
from pkm.planning import asset_block_text
from pkm.test_data.ids import sha_of

SHA = sha_of("a" * 64)


def _upload(client, name, content=b"PDFDATA", mime="application/pdf"):
    return client.post("/api/assets", files={"file": (name, content, mime)})


def test_asset_url_encodes_everything_but_unreserved():
    assert asset_url(SHA, "[draft] a).pdf") == f"/assets/{SHA}/%5Bdraft%5D%20a%29.pdf"
    assert asset_url(SHA, "100%.pdf") == f"/assets/{SHA}/100%25.pdf"
    assert asset_url(SHA, "café <1>.png") == f"/assets/{SHA}/caf%C3%A9%20%3C1%3E.png"
    assert asset_url(SHA, "a-b_c.d~e") == f"/assets/{SHA}/a-b_c.d~e"


def test_asset_label_never_holds_brackets():
    assert asset_label("[draft].png") == "(draft).png"
    assert asset_label("a]b[c") == "a)b(c"
    assert asset_label("Programme (Public).pdf") == "Programme (Public).pdf"


def test_asset_block_text_uses_a_label_that_cannot_open_a_page_ref():
    url = asset_url(SHA, "[draft].png")
    assert asset_block_text("[draft].png", "image/png", url) == f"![(draft).png]({url})"
    assert asset_block_text("[x].txt", "text/plain", url) == f"[(x).txt]({url})"


def test_upload_returns_the_encoded_url_and_it_is_served(client):
    body = _upload(client, "[draft] a).pdf").json()
    sha = hashlib.sha256(b"PDFDATA").hexdigest()
    assert body["url"] == f"/assets/{sha}/%5Bdraft%5D%20a%29.pdf"
    got = single_decode_get(client, body["url"])
    assert got.status_code == 200
    assert got.content == b"PDFDATA"


def test_search_returns_the_encoded_url(client):
    _upload(client, "Programme (Public) 100%.pdf")
    hit = client.get("/api/assets/search").json()["assets"][0]
    assert hit["filename"] == "Programme (Public) 100%.pdf"
    assert hit["url"].endswith("/Programme%20%28Public%29%20100%25.pdf")


def test_get_ignores_the_name_segment_so_raw_legacy_links_still_load(client):
    sha = _upload(client, "[draft] a).pdf").json()["sha256"]
    for segment in ("[draft] a).pdf", "Programme (Public).pdf", "anything"):
        assert client.get(f"/assets/{sha}/{segment}").content == b"PDFDATA"
