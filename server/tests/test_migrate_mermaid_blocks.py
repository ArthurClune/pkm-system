import sqlite3

from pkm.importer.migrate_mermaid_blocks import main
from pkm.server.db import init_db, open_db

PAGES = [
    (1, "Diagrams", None, None),
    (2, "mermaid", None, None),
]
BLOCKS = [
    # component block: {{[[mermaid]]}} with a nested diagram-source outline
    ("uid_component", 1, None, 0, "{{[[mermaid]]}}", None, 0, None, None),
    ("uid_line1", 1, "uid_component", 0, "flowchart TB", None, 0, None, None),
    ("uid_line2", 1, "uid_component", 1, "a --> b", None, 0, None, None),
    ("uid_line3", 1, "uid_line2", 0, "nested detail line", None, 0, None, None),
    # childless mention: must be left untouched
    ("uid_mention", 1, None, 1, "{{[[mermaid]]}}", None, 0, None, None),
    # unrelated block referencing "mermaid" only in passing text
    ("uid_plain", 1, None, 2, "not a diagram, just says [[mermaid]] in text",
     None, 0, None, None),
    # another component block, but a descendant of it is externally referenced
    ("uid_ref_component", 1, None, 3, "{{[[mermaid]]}}", None, 0, None, None),
    ("uid_ref_line1", 1, "uid_ref_component", 0, "flowchart LR", None, 0, None, None),
    ("uid_ref_line2", 1, "uid_ref_component", 1, "x --> y", None, 0, None, None),
    ("uid_citer", 1, None, 4, "see ((uid_ref_line2)) for detail", None, 0, None, None),
]
REFS = [
    ("uid_component", 2, "link"),  # from {{[[mermaid]]}}
    ("uid_mention", 2, "link"),    # from {{[[mermaid]]}}
    ("uid_plain", 2, "link"),      # from [[mermaid]] mention
    ("uid_ref_component", 2, "link"),
]


def _make_db(tmp_path):
    db_path = tmp_path / "pkm.sqlite3"
    init_db(db_path)
    con = open_db(db_path)
    con.executemany("INSERT INTO pages VALUES (?,?,?,?)", PAGES)
    con.executemany(
        "INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text,"
        " heading, collapsed, created_at, updated_at)"
        " VALUES (?,?,?,?,?,?,?,?,?)", BLOCKS)
    con.executemany("INSERT INTO refs VALUES (?,?,?)", REFS)
    con.commit()
    con.close()
    return db_path


def _rows(db_path):
    con = sqlite3.connect(db_path)
    con.row_factory = sqlite3.Row
    blocks = {r["uid"]: dict(r) for r in con.execute("SELECT * FROM blocks")}
    refs = {tuple(r) for r in
            con.execute("SELECT src_block_uid, target_page_id, kind FROM refs")}
    con.close()
    return blocks, refs


def test_dry_run_reports_but_does_not_write(tmp_path, capsys):
    db_path = _make_db(tmp_path)
    before_blocks, before_refs = _rows(db_path)

    rc = main(["--db", str(db_path), "--dry-run"])
    assert rc == 0

    out = capsys.readouterr().out
    assert "uid_component" in out
    assert "uid_mention" not in out  # childless: not a candidate

    after_blocks, after_refs = _rows(db_path)
    assert after_blocks == before_blocks
    assert after_refs == before_refs


def test_dry_run_reports_affected_uids_and_inbound_refs_for_preserved_descendants(
    tmp_path, capsys
):
    db_path = _make_db(tmp_path)

    rc = main(["--db", str(db_path), "--dry-run"])
    assert rc == 0

    lines = capsys.readouterr().out.splitlines()
    # the referenced descendant and its inbound referrer are both named
    preserved_line = next(line for line in lines if "uid_ref_line2" in line)
    assert "uid_citer" in preserved_line
    assert "uid_ref_component" in preserved_line  # names which component it's under
    # the component whose descendant is referenced must not be listed among
    # the blocks that would be converted -- only its unreferenced sibling is
    assert "  uid_component" in lines
    assert "  uid_ref_component" not in lines


def test_migration_converts_component_block_and_removes_descendants(tmp_path):
    db_path = _make_db(tmp_path)

    rc = main(["--db", str(db_path)])
    assert rc == 0

    blocks, refs = _rows(db_path)
    assert blocks["uid_component"]["text"] == (
        "```mermaid\nflowchart TB\na --> b\n  nested detail line\n```"
    )
    # descendants deleted (cascaded from a single DELETE on direct children)
    assert "uid_line1" not in blocks
    assert "uid_line2" not in blocks
    assert "uid_line3" not in blocks
    # the fence's own refs row to the mermaid page is gone
    assert ("uid_component", 2, "link") not in refs
    # childless mention untouched, including its own mermaid ref
    assert blocks["uid_mention"]["text"] == "{{[[mermaid]]}}"
    assert ("uid_mention", 2, "link") in refs
    # unrelated block untouched
    assert blocks["uid_plain"]["text"] == "not a diagram, just says [[mermaid]] in text"
    assert ("uid_plain", 2, "link") in refs


def test_migration_preserves_component_with_externally_referenced_descendant(tmp_path):
    db_path = _make_db(tmp_path)

    rc = main(["--db", str(db_path)])
    assert rc == 0

    blocks, refs = _rows(db_path)
    # left as an ordinary (still-trigger) block, not flattened into a fence
    assert blocks["uid_ref_component"]["text"] == "{{[[mermaid]]}}"
    assert ("uid_ref_component", 2, "link") in refs
    # both descendants survive, structure intact -- the reference still resolves
    assert blocks["uid_ref_line1"]["text"] == "flowchart LR"
    assert blocks["uid_ref_line1"]["parent_uid"] == "uid_ref_component"
    assert blocks["uid_ref_line2"]["text"] == "x --> y"
    assert blocks["uid_ref_line2"]["parent_uid"] == "uid_ref_component"
    # the referencing block is of course untouched too
    assert blocks["uid_citer"]["text"] == "see ((uid_ref_line2)) for detail"


def test_migration_is_idempotent(tmp_path, capsys):
    db_path = _make_db(tmp_path)
    assert main(["--db", str(db_path)]) == 0
    capsys.readouterr()
    blocks_after_first, refs_after_first = _rows(db_path)

    assert main(["--db", str(db_path)]) == 0
    out = capsys.readouterr().out
    assert "converted 0 block(s)" in out

    blocks_after_second, refs_after_second = _rows(db_path)
    assert blocks_after_second == blocks_after_first
    assert refs_after_second == refs_after_first


def test_fts_reflects_migration(tmp_path):
    db_path = _make_db(tmp_path)
    assert main(["--db", str(db_path)]) == 0

    con = sqlite3.connect(db_path)
    # the source line is now inside the fenced parent block (searching
    # "flowchart" alone would also hit uid_ref_line1's untouched, unrelated
    # "flowchart LR" -- that block is correctly preserved, not a collision)
    hits = con.execute(
        "SELECT blocks.uid FROM blocks_fts JOIN blocks ON blocks.rowid = blocks_fts.rowid"
        " WHERE blocks_fts MATCH 'TB'"
    ).fetchall()
    assert [h[0] for h in hits] == ["uid_component"]

    # the deleted child blocks no longer show up in search at all (searching
    # "detail" alone would also hit uid_citer's unrelated "for detail" text)
    hits = con.execute(
        "SELECT blocks.uid FROM blocks_fts JOIN blocks ON blocks.rowid = blocks_fts.rowid"
        " WHERE blocks_fts MATCH 'nested'"
    ).fetchall()
    assert [h[0] for h in hits] == ["uid_component"]
    con.close()
