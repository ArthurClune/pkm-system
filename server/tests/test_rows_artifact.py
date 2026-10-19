"""The committed web/src/replica/columns.gen.ts and
web/tooling/brandRegistry.gen.json must be exactly what `pkm.rows_dump`
generates from rows.py and brand_registry.py. Regenerate with:
`uv run python -m pkm.rows_dump`."""
import json

import pytest

from pkm import rows_dump
from pkm.rows import KEYS, KeySpec
from pkm.rows_dump import (COLUMNS_TS, REGISTRY_JSON, RowsDumpError,
                           columns_module, registry_json)


def test_committed_columns_artifact_matches_rows():
    assert COLUMNS_TS.exists(), f"missing artifact: {COLUMNS_TS}"
    assert COLUMNS_TS.read_text() == columns_module()


def test_committed_registry_artifact_matches_registry():
    assert REGISTRY_JSON.exists(), f"missing artifact: {REGISTRY_JSON}"
    assert REGISTRY_JSON.read_text() == registry_json()


def test_literal_keys_generate_unions_and_member_lists():
    out = columns_module()
    assert "  heading: 0 | 1 | 2 | 3 | null;" in out
    assert '  ref_kind: "link" | "tag" | "attribute";' in out
    assert "literals: [0, 1, 2, 3] }" in out


def test_registry_has_both_spellings():
    names = json.loads(registry_json())["names"]
    assert names["page_id"] == names["pageId"] == ["PageId"]


def test_unknown_client_brand_fails_loudly():
    with pytest.raises(RowsDumpError):
        rows_dump._client_key("x", "NoSuchBrand", False, set())


def test_server_brand_without_web_export_fails_loudly():
    with pytest.raises(RowsDumpError):
        rows_dump._server_key("page_id", KEYS["page_id"], set())


def test_literals_with_a_brand_fail_loudly():
    spec = KeySpec(str, "BlockUid", False, ("a", "b"))
    with pytest.raises(RowsDumpError):
        rows_dump._server_key("kind", spec, {"BlockUid"})
