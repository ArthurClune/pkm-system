from pkm.importer.report import ImportReport, render

REPORT = ImportReport(
    pages=8, implicit_pages=5, blocks=7, refs=9,
    orphan_blocks=1, skipped_entities=2,
    block_ref_count=1, embed_count=0,
    assets_total=2, assets_used=1,
    missing_asset_urls=("https://firebasestorage.googleapis.com/x/gone.png",),
    attr_counts={":node/title": 2, ":block/string": 7, ":block/refs": 4,
                 ":children/view-type": 1},
)


def test_render_headline_numbers():
    text = render(REPORT)
    assert "pages: 8 (5 implicit)" in text
    assert "blocks: 7" in text
    assert "block refs ((...)): 1" in text
    assert "embeds: 0" in text


def test_render_lists_ignored_attrs_and_missing_assets():
    text = render(REPORT)
    assert ":block/refs (4)" in text
    ignored = text.split("ignored attributes")[1].split("missing")[0]
    assert ":children/view-type" not in ignored
    assert ":node/title" not in ignored
    assert "gone.png" in text


def test_render_all_clear_sections():
    clean = ImportReport(pages=1, implicit_pages=0, blocks=1, refs=0,
                         orphan_blocks=0, skipped_entities=0,
                         block_ref_count=0, embed_count=0,
                         assets_total=0, assets_used=0,
                         missing_asset_urls=(), attr_counts={":node/title": 1})
    text = render(clean)
    assert "missing asset urls: none" in text
    assert "ignored attributes: none" in text
