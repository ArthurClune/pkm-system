from pkm.importer.assets import Asset, rewrite_asset_urls, url_basename

URL = ("https://firebasestorage.googleapis.com/v0/b/firescript-577a2.appspot.com/"
       "o/imgs%2Fapp%2Fgraph%2Fpaper-fig.png?alt=media&token=abc-123")
INDEX = {"paper-fig.png": Asset("f" * 64, "paper-fig.png", "image/png", 7)}


def test_url_basename_decodes_path():
    assert url_basename(URL) == "paper-fig.png"


def test_rewrites_known_url():
    text = f"figure: ![]({URL}) end"
    new, used, missing = rewrite_asset_urls(text, INDEX)
    assert new == f"figure: ![](/assets/{'f' * 64}/paper-fig.png) end"
    assert used == frozenset({"f" * 64})
    assert missing == frozenset()


def test_unknown_url_left_alone_and_reported():
    other = URL.replace("paper-fig", "gone")
    new, used, missing = rewrite_asset_urls(f"see {other}", INDEX)
    assert other in new
    assert used == frozenset()
    assert missing == frozenset({other})


def test_non_firebase_urls_untouched():
    text = "see https://example.com/x.png"
    assert rewrite_asset_urls(text, INDEX)[0] == text


def test_filename_needing_quoting():
    idx = {"my file (1).pdf": Asset("a" * 64, "my file (1).pdf", "application/pdf", 9)}
    url = ("https://firebasestorage.googleapis.com/v0/b/x/o/"
           "my%20file%20%281%29.pdf?alt=media")
    new, used, _ = rewrite_asset_urls(f"[pdf]({url})", idx)
    assert f"/assets/{'a' * 64}/my%20file%20%281%29.pdf" in new
    assert used == frozenset({"a" * 64})
