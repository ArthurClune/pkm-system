"""Markdown-export HTTP routes (pkm-uvqf): one page as .md, the whole
graph as a .zip. Both are plain downloads (text/markdown or
application/zip + Content-Disposition: attachment), not JSON payloads."""
import zipfile
from io import BytesIO


def test_export_page_markdown_returns_rendered_page(client):
    r = client.get("/api/export/page/Machine Learning")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/markdown")
    assert r.headers["content-disposition"] == \
        'attachment; filename="Machine Learning.md"'
    body = r.text
    assert body.startswith("# Machine Learning\n")
    assert "Tags:: #AI" in body
    assert "[[Attention Is All You Need]] is a [[Paper]]" in body


def test_export_page_markdown_resolves_block_refs(client):
    # uid_b5 on "July 7th, 2026" is "See ((uid_b3)) for details"; uid_b3's
    # text lives on "Machine Learning" and must be inlined, one level deep,
    # exactly like the nightly export_graph() does.
    r = client.get("/api/export/page/July 7th, 2026")
    assert r.status_code == 200
    assert "See (([[Attention Is All You Need]] is a [[Paper]])) for details" in r.text


def test_export_page_markdown_404s_for_missing_page(client):
    assert client.get("/api/export/page/No Such Page").status_code == 404


def test_export_page_markdown_requires_auth(anon_client):
    r = anon_client.get("/api/export/page/Machine Learning")
    assert r.status_code == 401


def test_export_all_markdown_returns_a_zip(client):
    r = client.get("/api/export.zip")
    assert r.status_code == 200
    assert r.headers["content-type"] == "application/zip"
    assert r.headers["content-disposition"].startswith("attachment;")
    with zipfile.ZipFile(BytesIO(r.content)) as zf:
        names = zf.namelist()
        assert "pages/Machine Learning.md" in names
        assert "pages/AI.md" in names
        assert any(n.startswith("journal/") for n in names)
        assert ".gitignore" in names
        page = zf.read("pages/Machine Learning.md").decode("utf-8")
        assert page.startswith("# Machine Learning\n")


def test_export_all_markdown_requires_auth(anon_client):
    r = anon_client.get("/api/export.zip")
    assert r.status_code == 401
