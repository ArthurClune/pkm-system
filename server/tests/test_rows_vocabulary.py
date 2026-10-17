import re
import sqlite3
from typing import NewType

import pytest

from pkm import brand_registry as reg
from pkm import goodlinks, refs, rows
from pkm.contracts import ops, responses
from pkm.refs import BLOCK_REF_TOKEN
from pkm.schema import DDL


def _declared_server_brands() -> set[str]:
    found: set[str] = set()
    for module in (ops, responses, goodlinks, refs):
        for value in vars(module).values():
            if (isinstance(value, NewType)
                    and hasattr(value, "__get_pydantic_json_schema__")):
                found.add(value.__name__)
    return found


def _tables(db: sqlite3.Connection) -> list[str]:
    names = [r[0] for r in db.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table'")]
    fts = {n for n in names if n.endswith("_fts")}
    return [n for n in names
            if not n.startswith("sqlite_")
            and not any(n.startswith(f + "_") and
                        n.endswith(reg.FTS_SHADOW_SUFFIXES) for f in fts)
            and n not in fts]


def _columns():
    db = sqlite3.connect(":memory:")
    db.executescript(DDL)
    for table in _tables(db):
        for _, name, ctype, notnull, _, pk in db.execute(
                f"PRAGMA table_info({table})"):
            key = reg.COLUMN_KEYS.get(table, {}).get(name, name)
            yield table, name, key, ctype, notnull, pk


def test_every_column_has_a_key():
    missing = [f"{t}.{c} -> {k}" for t, c, k, *_ in _columns()
               if k not in rows.KEYS]
    assert missing == []


def test_key_types_match_the_ddl():
    wrong = []
    for table, col, key, ctype, notnull, pk in _columns():
        spec = rows.KEYS.get(key)
        if spec is None:
            continue
        want = {"TEXT": str, "INTEGER": int}[ctype]
        nullable = notnull == 0 and pk == 0
        if spec.base is not want or spec.nullable != nullable:
            wrong.append(f"{table}.{col}")
    assert wrong == []


def test_client_keys_are_not_server_keys():
    assert set(reg.CLIENT_KEYS) & set(rows.KEYS) == set()


def test_names_point_at_declared_brands():
    declared = _declared_server_brands() | set(reg.WEB_BRANDS)
    used = ({b for brands in reg.NAMES.values() for b in brands}
            | set(reg.MINT_SITES) | set(reg.SHAPES))
    assert used - declared == set()
    assert {t for t, _ in reg.CLIENT_KEYS.values()
            if t[0].isupper()} - declared == set()


def test_every_server_brand_has_a_shape_and_mint_entry():
    declared = _declared_server_brands()
    assert declared - set(reg.SHAPES) == set()
    assert declared - set(reg.MINT_SITES) == set()


def test_shape_base_types_match_the_brands():
    for brand, (base, _) in reg.SHAPES.items():
        spec = next((s for s in rows.KEYS.values() if s.brand == brand), None)
        if spec is not None:
            assert spec.base is {"text": str, "int": int}[base], brand


def test_block_uid_shape_is_the_ref_token_and_the_wire_pattern():
    assert reg.SHAPES["BlockUid"][1] == BLOCK_REF_TOKEN
    assert ops.UID_RE.pattern == rf"^{reg.SHAPES['BlockUid'][1]}\Z"


@pytest.mark.parametrize("name", sorted(reg.NAMES))
def test_names_are_snake_case(name):
    assert re.fullmatch(r"[a-z][a-z0-9_]*", name)


def test_a_literal_key_takes_its_base_type_from_its_members():
    literal_keys = {k: s for k, s in rows.KEYS.items()
                    if s.literals is not None}
    assert {"heading", "view_type", "ref_kind", "rewrite_kind",
            "change_kind"} <= set(literal_keys)
    for key, spec in literal_keys.items():
        assert all(type(v) is spec.base for v in spec.literals or ()), key
