from __future__ import annotations

import json
import xml.etree.ElementTree as ET
from pathlib import Path

from pkm.server.mime_sniff import sniff_mime
from pkm.test_data.core import BlockSource, GraphSource, PageSource, parse_graph_source

TEST_DATA = Path(__file__).parents[2] / "test-data"
TEMPLATES = Path(__file__).parents[2] / "web/src/templates"


def test_committed_graph_covers_supported_examples() -> None:
    raw = json.loads((TEST_DATA / "graph.json").read_text(encoding="utf-8"))
    source = parse_graph_source(json.dumps(raw), asset_names={"sample.svg", "sample.pdf"})
    for page in source.pages:
        assert page.created_at == 1784332800000
        assert page.updated_at == 1784332860000
        for block in page.blocks:
            assert block.created_at == 1784332800000
            assert block.updated_at == 1784332860000

    pages = {page.title: page for page in source.pages}
    blocks = {str(block.uid): block for page in source.pages for block in page.blocks}

    assert {"Project Atlas", "Formatting Lab", "Garden 🌱", "July 18th, 2026"} <= pages.keys()
    assert blocks["atlas-outline"].view_type == "numbered"
    assert blocks["atlas-outline"].collapsed is True
    assert blocks["atlas-todo"].parent_uid == "atlas-outline"
    assert "{{[[TODO]]}}" in blocks["atlas-todo"].text
    assert "[[Formatting Lab]]" in blocks["atlas-todo"].text
    assert "#Research" in blocks["atlas-todo"].text
    assert "Status::" in blocks["atlas-status"].text
    assert "((format-table))" in blocks["atlas-block-ref"].text
    assert "| Feature | Example |" in blocks["format-table"].text
    assert "`inline code`" in blocks["format-code"].text
    assert "```python" in blocks["format-code"].text
    assert "```mermaid" in blocks["format-mermaid"].text
    assert "$E = mc^2$" in blocks["format-inline-math"].text
    assert blocks["format-display-math"].text.startswith("$$")
    assert blocks["format-invalid-math"].text == r"$$\notARealCommand{x}$$"
    assert "{{asset:sample.svg}}" in blocks["atlas-image"].text
    assert "{{asset:sample.pdf}}" in blocks["format-pdf"].text
    assert "[[Project Atlas]]" in blocks["garden-backlink"].text
    assert source.sidebar_entries == (
        "Project Atlas", "Formatting Lab", "Garden 🌱", "Reading List")


def _graph() -> GraphSource:
    text = (TEST_DATA / "graph.json").read_text(encoding="utf-8")
    return parse_graph_source(text, asset_names={"sample.svg", "sample.pdf"})


def _top_level(page: PageSource) -> list[str]:
    roots = [b for b in page.blocks if b.parent_uid is None]
    return [b.text for b in sorted(roots, key=lambda b: b.order_idx)]


def test_namespaced_pages_start_with_their_template() -> None:
    pages = _graph().pages
    for namespace in ("Paper", "Book"):
        keys = [line.removeprefix("- ").split("::")[0] for line in
                (TEMPLATES / f"{namespace}.md").read_text().splitlines()]
        members = [p for p in pages if p.title.startswith(f"{namespace}/")]
        assert len(members) >= 3, namespace
        for page in members:
            head = _top_level(page)[:len(keys)]
            assert [t.split("::")[0] for t in head] == keys, page.title
            assert head[0].startswith(f"Tags:: #{namespace}"), page.title


def test_graph_covers_queries_tables_and_todos() -> None:
    source = _graph()
    texts = [b.text for p in source.pages for b in p.blocks]
    queries = [t for t in texts if t.startswith("{{query:")]
    assert any("[[Book]]" in q and "| view: table" in q and "| columns:" in q
               for q in queries)
    assert any("| view: cards" in q for q in queries)
    assert any("[[Paper]]" in q and "| view:" not in q for q in queries)
    assert any("[[Article]]" in q for q in queries)
    assert any("[[TODO]]" in q for q in queries)

    blocks = [b for p in source.pages for b in p.blocks]
    children: dict[str, list[str]] = {}
    for b in blocks:
        if b.parent_uid is not None:
            children.setdefault(str(b.parent_uid), []).append(b.text)
    articles = [b for b in blocks if "#Article" in b.text]
    assert articles
    assert all(any("::" in c for c in children.get(str(b.uid), []))
               for b in articles)

    tables = [b for b in blocks if b.text == "{{table}}"]
    assert tables
    widths = {_row_width(blocks, r) for r in blocks
              if r.parent_uid == tables[0].uid}
    assert len(widths) == 1 and widths.pop() >= 2

    assert any(t.startswith("{{[[DONE]]}}") for t in texts)
    journals = [p.title for p in source.pages if p.title.startswith("July ")]
    assert len(journals) >= 2


def _row_width(blocks: list[BlockSource], first: BlockSource) -> int:
    width, cell = 1, first
    while (nxt := [b for b in blocks if b.parent_uid == cell.uid]):
        assert len(nxt) == 1
        width, cell = width + 1, nxt[0]
    return width


def test_graph_has_a_page_long_enough_to_scroll() -> None:
    long_page = next(
        p for p in _graph().pages if p.title == "Garden Journal Archive")
    assert _top_level(long_page)[0] == "{{toc}}"
    assert sum(1 for b in long_page.blocks if b.heading == 2) >= 8
    assert len(long_page.blocks) >= 40


def test_committed_media_are_valid_files() -> None:
    svg = (TEST_DATA / "assets/sample.svg").read_bytes()
    pdf = (TEST_DATA / "assets/sample.pdf").read_bytes()

    ET.fromstring(svg)
    assert sniff_mime(svg) == "image/svg+xml"
    assert sniff_mime(pdf) == "application/pdf"
    assert pdf.count(b"/Type /Page ") == 3
    assert pdf.endswith(b"%%EOF\n")
