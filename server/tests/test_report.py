from pkm.importer.report import ImportReport, render
from pkm.importer.titles import ImportTitleChange

REPORT = ImportReport(
    pages=8, implicit_pages=5, blocks=7, refs=9,
    orphan_blocks=1, skipped_entities=2,
    block_ref_count=1, embed_count=0,
    assets_total=2, assets_used=1,
    missing_asset_urls=("https://firebasestorage.googleapis.com/x/gone.png",),
    attr_counts={":node/title": 2, ":block/string": 7, ":block/refs": 4,
                 ":children/view-type": 1},
    title_changes=(
        ImportTitleChange(
            "Project [[Acme]]",
            "Project Acme",
            ("page[0]", "block uid-project"),
            True,
        ),
        ImportTitleChange("Topic #One", "Topic One", ("block uid-topic",), False),
    ),
)


def test_render_headline_numbers():
    text = render(REPORT)
    assert "pages: 8 (5 implicit)" in text
    assert "blocks: 7" in text
    assert "block refs ((...)): 1" in text
    assert "embeds: 0" in text


def test_render_lists_title_sanitization_changes():
    text = render(REPORT)
    assert "title spellings sanitized: 2" in text
    assert (
        '  "Project [[Acme]]" -> "Project Acme" '
        "(merged; page[0], block uid-project)"
    ) in text
    assert '  "Topic #One" -> "Topic One" (block uid-topic)' in text
    assert text.index("title spellings sanitized") < text.index("orphan blocks")


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
                         missing_asset_urls=(), attr_counts={":node/title": 1},
                         title_changes=())
    text = render(clean)
    assert "missing asset urls: none" in text
    assert "ignored attributes: none" in text


def test_render_lists_mermaid_preserved_refs():
    r = ImportReport(pages=1, implicit_pages=0, blocks=3, refs=0,
                     orphan_blocks=0, skipped_entities=0,
                     block_ref_count=1, embed_count=0,
                     assets_total=0, assets_used=0,
                     missing_asset_urls=(), attr_counts={":node/title": 1},
                     title_changes=(),
                     mermaid_preserved_refs=(("uid-line2", ("uid-citer",)),))
    text = render(r)
    assert "mermaid subtrees preserved (referenced descendants): 1" in text
    assert "uid-line2" in text and "uid-citer" in text


def test_render_mermaid_preserved_refs_none_by_default():
    text = render(REPORT)
    assert "mermaid subtrees preserved (referenced descendants): none" in text


def test_render_title_sanitization_none():
    clean = ImportReport(
        pages=1,
        implicit_pages=0,
        blocks=1,
        refs=0,
        orphan_blocks=0,
        skipped_entities=0,
        block_ref_count=0,
        embed_count=0,
        assets_total=0,
        assets_used=0,
        missing_asset_urls=(),
        attr_counts={},
        title_changes=(),
    )
    assert "title spellings sanitized: none" in render(clean)


def test_render_names_the_recovery_page_when_orphans_were_preserved():
    # Orphan blocks are no longer dropped, so the report must say where
    # they landed instead of implying they were never imported.
    r = ImportReport(pages=2, implicit_pages=0, blocks=3, refs=0,
                     orphan_blocks=2, skipped_entities=0,
                     block_ref_count=0, embed_count=0,
                     assets_total=0, assets_used=0,
                     missing_asset_urls=(), attr_counts={":node/title": 2},
                     title_changes=(),
                     recovery_page_title="Import recovery: unreachable blocks")
    text = render(r)
    orphan_line = next(line for line in text.splitlines() if line.startswith("orphan blocks"))
    assert "recovered to 'Import recovery: unreachable blocks'" in orphan_line
    assert orphan_line.endswith(": 2")
    assert "not imported" not in text
