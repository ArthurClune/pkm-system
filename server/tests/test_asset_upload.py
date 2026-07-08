import hashlib


def _upload(client, content=b"PNGDATA", name="pic.png", mime="image/png"):
    return client.post("/api/assets", files={"file": (name, content, mime)})


def test_upload_roundtrip(client, seeded_config):
    r = _upload(client)
    assert r.status_code == 200
    body = r.json()
    sha = hashlib.sha256(b"PNGDATA").hexdigest()
    assert body == {"sha256": sha, "filename": "pic.png",
                    "mime": "image/png", "size": 7,
                    "url": f"/assets/{sha}/pic.png"}
    assert (seeded_config.assets_dir / sha[:2] / sha).read_bytes() == b"PNGDATA"
    fetched = client.get(body["url"])
    assert fetched.status_code == 200
    assert fetched.content == b"PNGDATA"
    assert fetched.headers["content-type"] == "image/png"


def test_upload_requires_auth(anon_client):
    assert _upload(anon_client).status_code == 401


def test_upload_dedupes_by_content(client, seeded_config):
    first = _upload(client, name="a.png").json()
    second = _upload(client, name="b.png").json()
    assert second["sha256"] == first["sha256"]
    assert second["filename"] == "a.png"  # first row wins
    sha = first["sha256"]
    stored = list((seeded_config.assets_dir / sha[:2]).iterdir())
    assert [p.name for p in stored] == [sha]  # one file, no temp leftovers


def test_upload_empty_400(client):
    assert _upload(client, content=b"").status_code == 400
