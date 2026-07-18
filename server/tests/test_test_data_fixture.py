from __future__ import annotations

import json
import xml.etree.ElementTree as ET
from pathlib import Path

from pkm.server.mime_sniff import sniff_mime
from pkm.test_data.core import parse_graph_source

TEST_DATA = Path(__file__).parents[2] / "test-data"


def test_committed_graph_covers_supported_examples() -> None:
    raw = json.loads((TEST_DATA / "graph.json").read_text(encoding="utf-8"))
    source = parse_graph_source(raw, asset_names={"sample.svg", "sample.pdf"})
    pages = {page.title: page for page in source.pages}
    blocks = {block.uid: block for page in source.pages for block in page.blocks}

    assert {"Project Atlas", "Formatting Lab", "Garden 🌱", "July 18th, 2026"} <= pages.keys()
    assert blocks["atlas-outline"].view_type == "numbered"
    assert blocks["atlas-outline"].collapsed is True
    assert blocks["atlas-todo"].parent_uid == "atlas-outline"
    assert "{{[[TODO]]}}" in blocks["atlas-todo"].text
    assert "[[Formatting Lab]]" in blocks["atlas-todo"].text
    assert "#Research" in blocks["atlas-todo"].text
    assert "Status::" in blocks["atlas-status"].text
    assert "((format-table))" in blocks["atlas-block-ref"].text
    assert "{{embed: ((atlas-todo))}}" in blocks["format-embed"].text
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
    assert source.sidebar_entries == ("Project Atlas", "Formatting Lab", "Garden 🌱")


def test_committed_media_are_valid_files() -> None:
    svg = (TEST_DATA / "assets/sample.svg").read_bytes()
    pdf = (TEST_DATA / "assets/sample.pdf").read_bytes()

    ET.fromstring(svg)
    assert sniff_mime(svg) == "image/svg+xml"
    assert sniff_mime(pdf) == "application/pdf"
    assert pdf.count(b"/Type /Page ") == 3
    assert pdf.endswith(b"%%EOF\n")
