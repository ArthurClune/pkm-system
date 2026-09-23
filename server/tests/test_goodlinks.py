import pytest

from pkm.goodlinks import (GOODLINKS_PREFIX, candidate_urls, extract_goodlinks_hrefs,
                           goodlinks_href, is_link_id, link_id_from_href,
                           sanitize_article, search_match)

ID = "e4966bb2483b5c78f658398c0ae7b03f"


@pytest.mark.parametrize("value,ok", [
    (ID, True),
    (ID.upper(), False),
    (ID[:-1], False),
    (ID + "0", False),
    ("check", False),
    ("", False),
])
def test_is_link_id(value, ok):
    assert is_link_id(value) is ok


def test_href_round_trip():
    href = goodlinks_href(ID)
    assert href == GOODLINKS_PREFIX + ID
    assert link_id_from_href(href) == ID
    assert link_id_from_href("/api/goodlinks/not-hex") is None
    assert link_id_from_href("/api/local/x.pdf") is None


def test_extract_hrefs_from_links_and_bare_tokens():
    text = (f"Local copy:: [Goodlinks]({goodlinks_href(ID)}) and see {GOODLINKS_PREFIX}abc "
            f"again [dup]({goodlinks_href(ID)})")
    assert extract_goodlinks_hrefs(text) == [goodlinks_href(ID), GOODLINKS_PREFIX + "abc"]


def test_extract_hrefs_ignores_other_prefixes():
    assert extract_goodlinks_hrefs("[x](/api/local/a.pdf) plain text") == []


@pytest.mark.parametrize("url,expected", [
    ("https://a.example/p", ["https://a.example/p"]),
    ("https://a.example/p?utm=1", ["https://a.example/p?utm=1", "https://a.example/p"]),
    ("https://a.example/p#top", ["https://a.example/p#top", "https://a.example/p"]),
    ("https://a.example/p?x=1#top", ["https://a.example/p?x=1#top", "https://a.example/p"]),
])
def test_candidate_urls(url, expected):
    assert candidate_urls(url) == expected


def test_search_match_accepts_exactly_one_prefix_hit():
    results = [{"url": "https://a.example/p?publication_id=1", "id": "1"},
               {"url": "https://b.example/other", "id": "2"}]
    assert search_match(["https://a.example/p?utm=9", "https://a.example/p"], results) == results[0]


def test_search_match_rejects_zero_or_two_hits():
    two = [{"url": "https://a.example/p?x=1"}, {"url": "https://a.example/p?x=2"}]
    assert search_match(["https://a.example/p"], two) is None
    assert search_match(["https://a.example/p"], []) is None
    assert search_match(["https://a.example/p"], [{"url": "https://a.example/q"}]) is None


HOSTILE = """<div dir="auto"><p onclick="x()" style="color:red">Hello <b>bold</b>
<a href="javascript:alert(1)">bad</a> <a href="https://ok.example/x" title="t">good</a></p>
<script>alert(1)</script><style>p{display:none}</style>
<iframe src="https://evil.example"></iframe><form action="/x"><input></form>
<img src="data:image/png;base64,AAAA" alt="d"><img src="https://ok.example/i.png" alt="i">
<base href="https://evil.example/"><meta http-equiv="refresh" content="0;url=https://evil.example">
<table><tr><td colspan="2">cell</td></tr></table><pre><code>x</code></pre></div>"""


def test_sanitize_strips_hostile_markup_and_keeps_structure():
    out = sanitize_article(HOSTILE)
    for gone in ("<script", "alert(", "<style", "<iframe", "<form", "<input", "onclick", "style=",
                 "javascript:", "data:image", "<base", "<meta", "http-equiv"):
        assert gone not in out, gone
    for kept in ("<p>", "<b>bold</b>", "<td colspan=\"2\">cell</td>", "<pre><code>x</code></pre>",
                 'src="https://ok.example/i.png"', 'alt="i"', 'title="t"'):
        assert kept in out, kept


def test_sanitize_anchors_open_in_new_tab_without_referrer():
    out = sanitize_article('<p><a href="https://ok.example/x">good</a></p>')
    assert 'href="https://ok.example/x"' in out
    assert 'target="_blank"' in out
    assert 'rel="noopener noreferrer"' in out


def test_sanitize_drops_javascript_href_but_keeps_text():
    out = sanitize_article('<p><a href="javascript:alert(1)">bad</a></p>')
    assert "javascript:" not in out
    assert "bad" in out
