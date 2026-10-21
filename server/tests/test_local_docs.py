from pathlib import Path

import pytest

from pkm.local_docs import (LOCAL_PREFIX, clean_relative, disposition_for,
                            error_page_html, extract_local_hrefs, index_order,
                            is_within, local_href, media_type_for,
                            resolve_relative, visible_name, wants_html_error)


@pytest.mark.parametrize("raw, expected", [
    ("Papers/ML/Title.pdf", "Papers/ML/Title.pdf"),
    ("Papers/Machine%20Learning/It%27s.pdf", "Papers/Machine Learning/It's.pdf"),
    ("Papers//ML/x.pdf", "Papers/ML/x.pdf"),
    ("Papers/ML/", "Papers/ML"),
    ("caf%C3%A9/na%C3%AFve.pdf", "café/naïve.pdf"),
])
def test_resolve_relative_accepts_clean_paths(raw, expected):
    assert resolve_relative(raw) == expected


@pytest.mark.parametrize("raw", [
    "", "/", "../x.pdf", "Papers/../../etc/passwd", "Papers/%2e%2e/x.pdf",
    "Papers/./x.pdf", "/Papers/x.pdf", "Papers\\x.pdf", "Papers/x%00.pdf",
    "..", ".",
])
def test_resolve_relative_rejects_escapes(raw):
    assert resolve_relative(raw) is None


def test_clean_relative_does_not_decode_again():
    """`clean_relative` is called by the file route on a path uvicorn has
    already percent-decoded once; a literal `%` in the (already-decoded)
    name must survive unchanged, not be decoded a second time."""
    assert clean_relative("Papers/50% draft.pdf") == "Papers/50% draft.pdf"


@pytest.mark.parametrize("raw", [
    "", "/", "../x.pdf", "Papers/../../etc/passwd",
    "Papers/./x.pdf", "/Papers/x.pdf", "Papers\\x.pdf", "Papers/x\x00.pdf",
    "..", ".",
])
def test_clean_relative_rejects_escapes(raw):
    assert clean_relative(raw) is None


@pytest.mark.parametrize("name, kind", [
    ("a.pdf", "inline"), ("A.PDF", "inline"), ("a.png", "inline"),
    ("a.jpg", "inline"), ("a.jpeg", "inline"), ("a.gif", "inline"),
    ("a.webp", "inline"),
    ("a.zip", "attachment"), ("a.html", "attachment"), ("a.svg", "attachment"),
    ("a.epub", "attachment"), ("a.webarchive", "attachment"), ("noext", "attachment"),
])
def test_disposition_by_extension_only(name, kind):
    assert disposition_for(name) == kind


def test_media_type_falls_back_to_octet_stream():
    assert media_type_for("x.pdf") == "application/pdf"
    assert media_type_for("x.webarchive") == "application/octet-stream"
    assert media_type_for("x.svg") == "image/svg+xml"  # still an attachment


def test_media_type_is_a_fixed_table_not_the_host_registry():
    # Case-insensitive, covers office formats, and never consults the
    # host's MIME database (so results are identical on every machine).
    assert media_type_for("Deck.PPTX") == (
        "application/vnd.openxmlformats-officedocument.presentationml.presentation")
    assert media_type_for("x.docx") == (
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
    assert media_type_for("x.jpeg") == media_type_for("x.jpg") == "image/jpeg"
    assert media_type_for("README") == "application/octet-stream"
    assert media_type_for("x.unknownext") == "application/octet-stream"


def test_local_href_percent_encodes_everything_but_slashes():
    assert local_href("Papers/Machine Learning/It's (v2).pdf") == \
        LOCAL_PREFIX + "Papers/Machine%20Learning/It%27s%20%28v2%29.pdf"


def test_extract_local_hrefs_from_markdown_links_and_bare_urls():
    text = ("Local copy:: [a.pdf](/api/local/Papers/a.pdf) and "
            "[b](/api/local/Books/b%20c.pdf) bare /api/local/x/y.zip "
            "[a again](/api/local/Papers/a.pdf) [ext](https://x.org/a.pdf)")
    assert extract_local_hrefs(text) == [
        "/api/local/Papers/a.pdf", "/api/local/Books/b%20c.pdf",
        "/api/local/x/y.zip"]


def test_extract_local_hrefs_none():
    assert extract_local_hrefs("plain text [[Page]] /assets/ab/x.pdf") == []


def test_is_within_is_a_pure_prefix_check_on_resolved_paths():
    root = Path("/r/pkm")
    assert is_within(root, Path("/r/pkm/Papers/x.pdf"))
    assert is_within(root, Path("/r/pkm"))
    assert not is_within(root, Path("/r/pkm2/x.pdf"))
    assert not is_within(root, Path("/r/other/x.pdf"))


@pytest.mark.parametrize("mode, dest, accept, expected", [
    ("navigate", None, None, True),
    ("navigate", "document", "*/*", True),
    (None, "document", None, True),
    ("cors", "empty", "text/html", False),
    ("same-origin", "empty", "application/json", False),
    (None, None, "text/html,application/xhtml+xml,*/*;q=0.8", True),
    (None, None, "application/json", False),
    (None, None, "*/*", False),
    (None, None, None, False),
])
def test_wants_html_error(mode, dest, accept, expected):
    assert wants_html_error(mode, dest, accept) is expected


def test_error_page_html_escapes_everything():
    page = error_page_html(404, "not <b>here</b>", "<script>alert(1)</script>.pdf")
    assert "<script>" not in page
    assert "&lt;script&gt;alert(1)&lt;/script&gt;.pdf" in page
    assert "not &lt;b&gt;here&lt;/b&gt;" in page
    assert "404" in page
    assert "<script" not in page.lower()


def test_error_page_html_without_path():
    page = error_page_html(503, "try again", None)
    assert "<code>" not in page
    assert "503" in page


def test_visible_name_maps_icloud_stub_to_real_name():
    assert visible_name(".Gone.pdf.icloud", is_dir=False) == "Gone.pdf"


def test_visible_name_hides_dotfiles_and_dot_dirs():
    assert visible_name(".DS_Store", is_dir=False) is None
    assert visible_name(".icloud", is_dir=False) is None
    assert visible_name("..icloud", is_dir=False) is None
    assert visible_name("..hidden.icloud", is_dir=False) is None
    assert visible_name("...icloud", is_dir=False) is None
    assert visible_name("....icloud", is_dir=False) is None
    assert visible_name(".Trash", is_dir=True) is None
    assert visible_name("Papers", is_dir=True) == "Papers"
    assert visible_name("50% draft.pdf", is_dir=False) == "50% draft.pdf"


def test_index_order_dedupes_and_sorts_case_insensitively():
    assert index_order(["b/x.pdf", "A/y.pdf", "b/x.pdf", "a/z.pdf"]) == \
        ["A/y.pdf", "a/z.pdf", "b/x.pdf"]
