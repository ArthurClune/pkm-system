"""Whatever the importer writes, and whatever older versions of it wrote,
the reads serialise: page fetch, page export, block fetch, the journal,
the sync snapshot and the changes feed all answer 200.

An export is generated as the datoms of a Roam `#datascript/DB` and runs
through the importer's own pipeline (parse_export, the structure, uid and
title checks, to_rows, insert_rows, then the title migration), so each
attribute arrives as Roam could send it: a heading of any int, a bool or
a string, times that are huge, negative, fractional or text, any view
type keyword. An import the pipeline refuses is a refusal, not a
failure. Older databases are drawn too: Roam's heading 0 written as is
(as imports did before parse_export read it as no heading), and a
database that never ran the title migration."""
import math
import time

import pytest
from asgi_harness import encode_segment, open_harness
from hostile import count, event, hostile_text, text_labels, with_floors
from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st
from rawread import read

from pkm.contracts.int64 import INT64_MAX, INT64_MIN
from pkm.contracts.text import well_formed
from pkm.database import connect
from pkm.edn import Tagged
from pkm.importer.parse_export import parse_export
from pkm.importer.preflight import (ImportStructureError, ImportUidError,
                                    validate_export_structure,
                                    validate_export_uids)
from pkm.importer.rows import to_rows
from pkm.importer.run import insert_rows
from pkm.importer.titles import sanitize_export_titles
from pkm.refs import title_syntax_reason
from pkm.schema import DDL
from pkm.server.title_migration import (BlockedTitleMigration,
                                        apply_title_migration,
                                        audit_title_migration)

_MANY = {":db/valueType": ":db.type/ref",
         ":db/cardinality": ":db.cardinality/many"}
_SCHEMA = {":block/children": _MANY}

_absent = st.just(None)
# What Roam may send for an attribute the importer reads as an int.
_raw_int = st.one_of(
    st.integers(-3, 9), st.integers(0, 2 * 10 ** 12),
    st.integers(INT64_MIN, INT64_MAX), st.integers(INT64_MAX, 2 ** 70),
    st.booleans(),
    st.floats(allow_nan=False, allow_infinity=False),
    st.sampled_from([math.nan, math.inf]), st.text(max_size=3))
_raw_heading = st.one_of(_absent, st.just(0), st.integers(1, 3), _raw_int)
# One strategy per kind of `:block/heading` Roam may send, run as its own
# property so every kind, and the stored 0 and levels they leave, are
# reached by construction. `leveled` gives the blocks 1, 2, 3 in turn and
# `legacy_zero` omits the attribute then stores the 0 older imports wrote.
EXAMPLES_PER_CELL = 8
_HEADINGS: dict[str, st.SearchStrategy[object] | None] = {
    "any": _raw_heading,
    "leveled": None,
    "legacy_zero": _absent,
    "negative": st.integers(-3, -1),
    "out_of_range": st.integers(4, 9),
    "float": st.floats(allow_nan=False, allow_infinity=False),
    "past_int64": st.integers(INT64_MAX + 1, 2 ** 70),
    "bool": st.booleans(),
}
_raw_time = st.one_of(_absent, _raw_int)
_raw_view_type = st.one_of(_absent, st.sampled_from(
    [":numbered", ":document", ":bullet", "numbered", 3, True]))
_raw_open = st.one_of(_absent, st.booleans(), st.sampled_from([0, 1, "x"]))
_stored_text = hostile_text.map(well_formed)
# Half the titles plain, so most exports pass the importer's title checks
# and reach the reads.
_title = st.integers(0, 1).flatmap(lambda i: _stored_text if i else
                                   st.from_regex(r"[A-Z][a-z]{2,8}",
                                                 fullmatch=True))
_uid = st.from_regex(r"[a-zA-Z0-9_-]{6,12}", fullmatch=True)


def _raw_kind(value: object) -> str:
    if isinstance(value, bool) or not isinstance(value, int):
        return type(value).__name__
    if value in (0, 1, 2, 3):
        return str(value)
    return "int past 64 bits" if not INT64_MIN <= value <= INT64_MAX \
        else "other int"


@st.composite
def roam_exports(draw, heading: str = "any", refused_title: bool = False
                 ) -> Tagged:
    """An export whose blocks' headings are of the `heading` kind; with
    `refused_title`, one page title the importer refuses."""
    titles = draw(st.lists(_title, min_size=1, max_size=3))
    if refused_title:
        titles[0] = "]]" + titles[0]
    uids = draw(st.lists(_uid, min_size=3, max_size=8, unique=True))
    datoms: list[list[object]] = []

    def put(eid: int, attr: str, value: object) -> None:
        if value is None:
            return
        if attr in (":block/heading", ":create/time"):
            event(f"sent {attr}: {_raw_kind(value)}")
        datoms.append([eid, attr, value, 536870913])

    page_eids = list(range(1, len(titles) + 1))
    for eid, title in zip(page_eids, titles):
        put(eid, ":node/title", title)
        put(eid, ":create/time", draw(_raw_time))
        put(eid, ":edit/time", draw(_raw_time))
    block_eids: list[int] = []
    kind = _HEADINGS[heading]
    for i, uid in enumerate(uids):
        eid = 100 + i
        parent = draw(st.sampled_from(page_eids + block_eids))
        put(parent, ":block/children", eid)
        text = draw(_stored_text)
        ref = draw(st.sampled_from(["", "uid", "title"]))
        if ref == "uid":
            text += f" (({draw(st.sampled_from(uids))}))"
        elif ref == "title":
            text += f" [[{draw(st.sampled_from(titles))}]]"
        put(eid, ":block/uid", uid)
        put(eid, ":block/string", text)
        for label in text_labels(text):
            event(f"block text: {label}")
        put(eid, ":block/order", draw(st.integers(0, 3)))
        put(eid, ":block/heading",
            1 + i % 3 if kind is None else draw(kind))
        put(eid, ":block/open", draw(_raw_open))
        put(eid, ":children/view-type", draw(_raw_view_type))
        put(eid, ":create/time", draw(_raw_time))
        put(eid, ":edit/time", draw(_raw_time))
        block_eids.append(eid)
    return Tagged("datascript/DB", {":schema": _SCHEMA, ":datoms": datoms})


def _import(export_value: Tagged, path, migrate: bool,
            legacy_heading_zero: bool) -> bool:
    """Run the importer's pipeline into a new database at `path`; False
    when the importer refuses the export."""
    export = parse_export(export_value)
    try:
        validate_export_structure(export)
        validate_export_uids(export)
        export = sanitize_export_titles(export).export
    except (ImportStructureError, ImportUidError) as exc:
        event(f"import refused: {type(exc).__name__}")
        return False
    rows = to_rows(export, lambda text: text)
    db = connect(path)
    try:
        db.executescript(DDL)
        insert_rows(db, rows)
        if legacy_heading_zero:
            db.execute("UPDATE blocks SET heading = 0 WHERE heading IS NULL")
        db.commit()
        if migrate:
            plan = audit_title_migration(db)
            apply_title_migration(db, plan.digest,
                                  now_ms=int(time.time() * 1000))
    except BlockedTitleMigration:
        event("import refused: title migration blocked")
        return False
    finally:
        db.close()
    return True


def _label_stored(path) -> set[object]:
    """Label what the import stored; the headings it holds."""
    db = connect(path)
    headings: set[object] = set()
    try:
        for heading, in read(db, "SELECT DISTINCT heading AS h FROM blocks"):
            event(f"stored heading: {heading!r}")
            headings.add(heading)
        for kind, in read(db, "SELECT DISTINCT typeof(created_at) AS t"
                              " FROM blocks"):
            event(f"stored block created_at: {kind}")
    finally:
        db.close()
    return headings


@settings(max_examples=20, deadline=None, database=None)
@given(export=roam_exports(refused_title=True))
def test_an_export_with_a_refused_title_is_skipped(export):
    """A page title the importer cannot sanitize is skipped, not created and
    not refused; reached by construction, not by a floor."""
    parsed = parse_export(export)
    validate_export_structure(parsed)
    validate_export_uids(parsed)
    result = sanitize_export_titles(parsed)
    assert result.skipped_pages
    for page in result.export.pages:
        assert title_syntax_reason(page.title) is None


@pytest.fixture(scope="module")
def harness(tmp_path_factory):
    with open_harness(tmp_path_factory.mktemp("stored")) as opened:
        yield opened


# Floors: see `with_floors` in hostile.py for how they were set. The stored
# headings and the import refusal are guaranteed by construction instead:
# every (migration, heading kind) cell is its own property, the two kinds
# that decide what is stored assert it, and a refused title has its own.
@with_floors({
    "refused title: True": 0.22, "block text: NUL": 0.016, "block text: [[": 0.5, "block text: very long": 0.04,
    "sent :create/time: int past 64 bits": 0.1,
    "stored block created_at: integer": 0.17, "stored block created_at: null": 0.17,
}, per="case")
def test_every_imported_row_is_served(harness, tmp_path_factory):
    for migrate in (True, False):
        for heading in _HEADINGS:
            @settings(max_examples=EXAMPLES_PER_CELL, deadline=None,
                      database=None, suppress_health_check=[
                          HealthCheck.function_scoped_fixture,
                          HealthCheck.too_slow, HealthCheck.data_too_large])
            @given(data=st.data(), legacy_heading_zero=st.booleans())
            def cell(data, legacy_heading_zero):
                _import_is_served(harness, tmp_path_factory, data, migrate,
                                  heading, legacy_heading_zero)

            cell()


def _import_is_served(harness, tmp_path_factory, data, migrate: bool,
                      heading: str, legacy_heading_zero: bool) -> None:
    count("case")
    refused_title = data.draw(st.booleans())
    event(f"refused title: {refused_title}")
    export = data.draw(roam_exports(heading, refused_title))
    legacy_heading_zero = legacy_heading_zero or heading == "legacy_zero"
    path = tmp_path_factory.mktemp("import") / "pkm.sqlite3"
    if not _import(export, path, migrate, legacy_heading_zero):
        # A refused title is skipped, so it never stops an import.
        assert not refused_title
        return
    event(f"imported, title migration {'applied' if migrate else 'not run'}")
    stored = _label_stored(path)
    if refused_title:
        stored_db = connect(path)
        try:
            assert all(
                title_syntax_reason(row["title"]) is None
                for row in stored_db.select("SELECT title FROM pages"))
        finally:
            stored_db.close()
    if heading == "leveled":
        assert {1, 2, 3} <= stored, stored
    if heading == "legacy_zero":
        assert 0 in stored, stored
    source = connect(path)
    try:
        harness.reset(source)
    finally:
        source.close()

    def ok(url: str) -> dict:
        response = harness.send("GET", url)
        assert response.status_code == 200, (url, response.text[:300])
        return response.json() if "json" in response.headers.get(
            "content-type", "") else {}

    snapshot = ok("/api/sync/snapshot")
    ok("/api/sync/changes?since=0&limit=5000")
    ok("/api/journal")
    for page in snapshot["pages"]:
        title = encode_segment(page["title"])
        ok(f"/api/page/{title}")
        ok(f"/api/export/page/{title}")
    # A stored 0 (no heading, as older imports wrote it) is served as null.
    for block in snapshot["blocks"]:
        assert block["heading"] in (None, 1, 2, 3), block
    for block in snapshot["blocks"]:
        ok(f"/api/block/{encode_segment(block['uid'])}")
