from pathlib import Path

import pytest

from pkm.local_docs import (LOCAL_PREFIX, disposition_for, extract_local_hrefs,
                            is_within, local_href, media_type_for,
                            resolve_relative)


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
