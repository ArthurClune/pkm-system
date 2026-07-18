from __future__ import annotations

import re
from typing import Any

import pytest

from pkm.importer.assets import Asset
from pkm.importer.rows import Rows
from pkm.test_data.core import (
    SourceValidationError,
    build_rows,
    expand_asset_placeholders,
    parse_graph_source,
)

ASSETS = {
    "sample.svg": Asset(
        sha256="ab" * 32,
        filename="sample image.svg",
        mime="image/svg+xml",
        size=123,
    ),
}


def valid_source() -> dict[str, Any]:
    return {
        "pages": [{
            "title": "Project Atlas",
            "created_at": 1784332800000,
            "updated_at": 1784332860000,
            "blocks": [
                {
                    "uid": "atlas-root",
                    "parent_uid": None,
                    "order_idx": 0,
                    "text": "Root ![sample]({{asset:sample.svg}})",
                    "heading": 1,
                    "collapsed": True,
                    "view_type": "numbered",
                    "created_at": 1784332800000,
                    "updated_at": 1784332860000,
                },
                {
                    "uid": "atlas-child",
                    "parent_uid": "atlas-root",
                    "order_idx": 0,
                    "text": "Child",
                    "heading": None,
                    "collapsed": False,
                    "view_type": None,
                    "created_at": None,
                    "updated_at": None,
                },
            ],
        }],
        "sidebar_entries": ["Project Atlas"],
    }


def test_parse_graph_source_accepts_strict_valid_source() -> None:
    source = parse_graph_source(valid_source(), asset_names={"sample.svg"})
    assert source.pages[0].blocks[0].collapsed is True
    assert source.sidebar_entries == ("Project Atlas",)


def test_expand_asset_placeholders_quotes_filename() -> None:
    assert expand_asset_placeholders("![x]({{asset:sample.svg}})", ASSETS) == (
        f"![x](/assets/{'ab' * 32}/sample%20image.svg)"
    )


def test_build_rows_preserves_tree_presentation_and_derives_refs() -> None:
    raw = valid_source()
    raw["pages"][0]["blocks"][1]["text"] = (
        "Status:: [[Active]] #Research ((atlas-root)) {{embed: ((atlas-root))}}"
    )
    source = parse_graph_source(raw, asset_names=ASSETS.keys())
    source_before = source.model_copy(deep=True)

    prepared = build_rows(source, ASSETS)
    prepared_again = build_rows(source, ASSETS)

    assert isinstance(prepared.rows, Rows)
    pages_by_title = {row[1]: row for row in prepared.rows.pages}
    assert {"Project Atlas", "Active", "Research"} <= pages_by_title.keys()
    blocks_by_uid = {row[0]: row for row in prepared.rows.blocks}
    assert blocks_by_uid["atlas-root"][6] == 1
    assert blocks_by_uid["atlas-root"][9] == "numbered"
    assert blocks_by_uid["atlas-child"][2] == "atlas-root"
    assert blocks_by_uid["atlas-child"][3] == 0
    refs = {
        (uid, prepared.rows.pages[target_id - 1][1], kind)
        for uid, target_id, kind in prepared.rows.refs
    }
    assert ("atlas-child", "Active", "link") in refs
    assert ("atlas-child", "Status", "attribute") in refs
    assert ("atlas-child", "Research", "tag") in refs
    assert prepared.rows.block_ref_count == 2
    assert prepared.rows.embed_count == 1
    assert prepared.sidebar_rows == (("Project Atlas", 0),)
    assert source == source_before
    assert prepared == prepared_again


@pytest.mark.parametrize(
    ("mutate", "message"),
    [
        (lambda raw: raw["pages"].append(raw["pages"][0].copy()), "duplicate page title: Project Atlas"),
        (lambda raw: raw["pages"][0]["blocks"].append({**raw["pages"][0]["blocks"][1]}), "duplicate block uid: atlas-child"),
        (lambda raw: raw["pages"][0]["blocks"][1].update(parent_uid="missing"), "atlas-child: unknown parent uid: missing"),
        (lambda raw: raw["pages"][0]["blocks"][0].update(parent_uid="atlas-child"), "parent cycle: atlas-root -> atlas-child -> atlas-root"),
        (lambda raw: raw["pages"][0]["blocks"][1].update(order_idx=2), "non-contiguous order_idx under atlas-root: expected [0], got [2]"),
        (lambda raw: raw.update(sidebar_entries=["Project Atlas", "Project Atlas"]), "duplicate sidebar title: Project Atlas"),
        (lambda raw: raw.update(sidebar_entries=["Missing"]), "sidebar title is not an explicit page: Missing"),
        (lambda raw: raw["pages"][0]["blocks"][0].update(text="{{asset:missing.pdf}}"), "unknown asset placeholder: missing.pdf"),
    ],
)
def test_parse_graph_source_rejects_graph_invariants(mutate, message: str) -> None:
    raw = valid_source()
    mutate(raw)
    with pytest.raises(SourceValidationError, match=re.escape(message)):
        parse_graph_source(raw, asset_names={"sample.svg"})


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("heading", 4),
        ("collapsed", "true"),
        ("view_type", "bulleted"),
        ("order_idx", -1),
    ],
)
def test_parse_graph_source_rejects_invalid_strict_fields(field: str, value: object) -> None:
    raw = valid_source()
    raw["pages"][0]["blocks"][0][field] = value
    with pytest.raises(SourceValidationError, match=rf"pages\.0\.blocks\.0\.{field}"):
        parse_graph_source(raw, asset_names={"sample.svg"})


@pytest.mark.parametrize("value", [True, 3.0])
def test_parse_graph_source_rejects_strict_heading_coercion(value: object) -> None:
    raw = valid_source()
    raw["pages"][0]["blocks"][0]["heading"] = value
    with pytest.raises(SourceValidationError, match=r"pages\.0\.blocks\.0\.heading"):
        parse_graph_source(raw, asset_names={"sample.svg"})


def test_parse_graph_source_rejects_cross_page_parent() -> None:
    raw = valid_source()
    raw["pages"].append({
        "title": "Other",
        "created_at": None,
        "updated_at": None,
        "blocks": [{
            "uid": "other-root",
            "parent_uid": None,
            "order_idx": 0,
            "text": "Other root",
            "heading": None,
            "collapsed": False,
            "view_type": None,
            "created_at": None,
            "updated_at": None,
        }],
    })
    raw["pages"][0]["blocks"][1]["parent_uid"] = "other-root"
    with pytest.raises(
        SourceValidationError,
        match="atlas-child: parent uid belongs to another page: other-root",
    ):
        parse_graph_source(raw, asset_names={"sample.svg"})
