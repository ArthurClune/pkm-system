import json
import sqlite3

import pytest

from pkm.cli.main import main
from pkm.contracts.daily import title_for_date


def _seed_migration_graph(db_path) -> None:
    con = sqlite3.connect(db_path)
    con.executemany(
        "INSERT INTO pages(id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
        [
            (10, "Acme", 10, 11),
            (11, " Acme", 20, 21),
            (12, "Acme ", 30, 31),
            (13, " Beta ", 40, 41),
            (14, "Beta ", 50, 51),
            (15, "Inbound", 60, 61),
            (16, "Unrelated", 70, 71),
            (17, "\u00a0Gamma\u00a0", 80, 81),
        ],
    )
    con.executemany(
        "INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text, collapsed) "
        "VALUES (?, ?, ?, ?, ?, 0)",
        [
            ("target-root", 10, None, 0, "target"),
            ("source-leading", 11, None, 0, "self [[ Acme]] and [[Unrelated]]"),
            ("child-leading", 11, "source-leading", 0, "child"),
            ("source-trailing", 12, None, 0, "trailing"),
            ("beta-first", 13, None, 0, "beta first"),
            ("beta-second", 14, None, 0, "beta second"),
            (
                "inbound",
                15,
                None,
                0,
                "[[ Acme]] + [[Acme ]] + [[ Beta ]] + [[Beta ]] + [[Unrelated]]",
            ),
            ("inbound-two", 15, None, 1, "again [[ Acme]]"),
            ("unrelated-root", 16, None, 0, "untouched"),
        ],
    )
    con.executemany(
        "INSERT INTO refs(src_block_uid, target_page_id, kind) VALUES (?, ?, ?)",
        [
            ("source-leading", 11, "link"),
            ("source-leading", 16, "link"),
            ("beta-first", 16, "link"),
            ("inbound", 11, "link"),
            ("inbound", 12, "link"),
            ("inbound", 13, "link"),
            ("inbound", 14, "link"),
            ("inbound", 16, "link"),
            ("inbound-two", 11, "link"),
        ],
    )
    con.executemany(
        "INSERT INTO sidebar_entries(id, title, order_idx) VALUES (?, ?, ?)",
        [
            (10, "Acme", 0),
            (11, " Acme", 1),
            (12, "Beta ", 2),
            (13, "Unrelated", 3),
        ],
    )
    con.commit()
    con.close()


@pytest.fixture()
def run(pkm_client, capsys):
    def _run(*argv: str) -> tuple[int, str, str]:
        code = main(list(argv), make_client=lambda: pkm_client)
        out, err = capsys.readouterr()
        return code, out, err
    return _run


def test_get_page_markdown(run):
    code, out, _ = run("get", "Machine Learning")
    assert code == 0
    assert out.startswith("# Machine Learning\n")
    assert "- ## Papers" in out


def test_get_page_json(run):
    code, out, _ = run("get", "Machine Learning", "--json")
    assert json.loads(out)["page"]["title"] == "Machine Learning"


def test_get_normalizes_control_whitespace_title(run, pkm_client):
    pkm_client.post_ops([
        {"op": "create_page", "page_title": "Ctrl\tTitle"},
        {"op": "create", "uid": "cligetctrl01", "page_title": "Ctrl\tTitle",
         "parent_uid": None, "order_idx": 0, "text": "cli body"},
    ], batch_id="cli-get-ctrlws-0001")

    code, out, _ = run("get", "Ctrl\tTitle")

    assert code == 0
    assert out.startswith("# Ctrl Title\n")
    assert "cli body" in out


def test_get_uids_flag(run):
    _, out, _ = run("get", "Machine Learning", "--uids")
    assert "^uid_b1" in out


def test_get_today_creates_and_renders_daily(run):
    code, out, _ = run("get", "today")
    assert code == 0
    from datetime import date
    assert out.startswith(f"# {title_for_date(date.today())}\n")


def test_get_addresses_a_legacy_leading_dash_uid_via_double_dash(
        run, pkm_client):
    # Pre-pkm-y5yv uids (e.g. imported from Roam) can begin with '-'; a bare
    # CLI argument like that is swallowed by argparse as an unknown option,
    # so the documented workaround is `--` to end option parsing.
    legacy_uid = "-legacy1a2b3c"
    pkm_client.post_ops([
        {"op": "create", "uid": legacy_uid, "page_title": "AI",
         "parent_uid": None, "order_idx": 50, "text": "legacy dash block"},
    ], batch_id="legacy-dash-get")
    code, out, _ = run("get", "--", legacy_uid)
    assert code == 0
    assert "legacy dash block" in out


def test_get_a_leading_dash_uid_without_double_dash_is_rejected_by_argparse(
        run, pkm_client):
    legacy_uid = "-legacy1a2b3c"
    pkm_client.post_ops([
        {"op": "create", "uid": legacy_uid, "page_title": "AI",
         "parent_uid": None, "order_idx": 51, "text": "legacy dash block 2"},
    ], batch_id="legacy-dash-get-noguard")
    with pytest.raises(SystemExit) as e:
        run("get", legacy_uid)
    assert e.value.code == 2


def test_get_block_by_uid(run):
    code, out, _ = run("get", "uid_b3")
    assert code == 0
    assert out.startswith("(in: Machine Learning > Papers)")


def test_get_uid_shaped_page_title_falls_back(run, pkm_client):
    pkm_client.create_page("uidlike")
    code, out, _ = run("get", "uidlike")
    assert code == 0
    assert out.startswith("# uidlike\n")


def test_get_missing_page_exits_1_with_stderr(run):
    code, out, err = run("get", "No Such Page")
    assert code == 1
    assert out == ""
    assert err == "404: page not found\n"


def test_search(run):
    code, out, _ = run("search", "Papers")
    assert code == 0
    assert "## Blocks" in out


def test_search_exact_flag(run):
    code, out, _ = run("search", "machi", "--exact")
    assert code == 0
    assert out == "no results\n"


def test_json_output_is_minified(run):
    code, out, _ = run("get", "Machine Learning", "--json")
    assert code == 0
    assert out.startswith('{"page":')
    assert '": ' not in out  # no space after separators = minified
    assert "\n" not in out.rstrip("\n")


def test_search_default_limit_is_10():
    from pkm.cli.main import build_parser
    args = build_parser().parse_args(["search", "x"])
    assert args.limit == 10


def test_search_compact(run):
    code, out, _ = run("search", "Papers", "--compact")
    assert code == 0
    assert "^uid_b2" in out
    assert "<mark>" not in out


def test_refs(run):
    code, out, _ = run("refs", "Machine Learning")
    assert code == 0
    assert out.startswith("# Backlinks: Machine Learning (1 pages)")
    assert "July 7th, 2026" in out


def test_refs_normalizes_control_whitespace_title(run, pkm_client):
    pkm_client.post_ops([
        {"op": "create_page", "page_title": "Ctrl\tTitle"},
        {"op": "create", "uid": "clirefsctrl1", "page_title": "Ctrl Source",
         "parent_uid": None, "order_idx": 0, "text": "See [[Ctrl Title]]"},
    ], batch_id="cli-refs-ctrlws-0001")

    code, out, _ = run("refs", "Ctrl\tTitle", "--json")

    assert code == 0
    payload = json.loads(out)
    assert payload["total_pages"] == 1
    assert payload["groups"][0]["page_title"] == "Ctrl Source"


def test_refs_returns_every_group_beyond_the_single_page_cap(
        run, seed_backlinks):
    # The route caps a single response to 100 backlink groups; `pkm refs`
    # wording promises every linking block, so 101 extra sources (plus the
    # seeded one) must all show up, not just the first 100 (pkm-3cyg).
    seed_backlinks(101)
    code, out, _ = run("refs", "Machine Learning")
    assert code == 0
    assert out.startswith("# Backlinks: Machine Learning (102 pages)")
    assert "## BL Source 000" in out
    assert "## BL Source 100" in out


def test_query(run):
    code, out, _ = run("query", "{and: [[Paper]]}")
    assert code == 0
    assert "^uid_b3" in out
    assert "(1 total)" in out


def test_query_parse_error_exits_1(run):
    code, _, err = run("query", "{nope: [[X]]}")
    assert code == 1
    assert "unsupported clause" in err


def test_query_expand_flag(run):
    _, base, _ = run("query", "{and: [[AI]]}")
    assert "^uid_b4" not in base
    code, out, _ = run("query", "{and: [[AI]]}", "--expand")
    assert code == 0
    assert "^uid_b4" in out and "^uid_b1" in out


def test_query_empty_result_prints_hint(run):
    code, out, _ = run("query", "{and: [[Paper]] [[AI]]}")
    assert code == 0
    assert "(0 total)" in out
    assert "per-ref block counts: [[Paper]] 1, [[AI]] 1" in out


def test_todos_empty(run):
    code, out, _ = run("todos")
    assert code == 0
    assert "(0 total)" in out


def test_login_writes_config(monkeypatch, tmp_path, anon_client, capsys):
    import pkm.cli.main as cli_main
    monkeypatch.setenv("PKM_CLI_CONFIG", str(tmp_path / "c.json"))
    monkeypatch.setattr(cli_main, "_login_http", lambda url: anon_client)
    monkeypatch.setattr("getpass.getpass", lambda prompt: "test-pw")
    code = main(["login", "--url", "http://testserver"])
    assert code == 0
    saved = json.loads((tmp_path / "c.json").read_text())
    assert saved["url"] == "http://testserver"
    assert saved["token"].startswith("v1.")
    assert "logged in" in capsys.readouterr().out


def test_login_password_stdin(monkeypatch, tmp_path, anon_client, capsys):
    import io
    import pkm.cli.main as cli_main
    monkeypatch.setenv("PKM_CLI_CONFIG", str(tmp_path / "c.json"))
    monkeypatch.setattr(cli_main, "_login_http", lambda url: anon_client)
    monkeypatch.setattr("sys.stdin", io.StringIO("test-pw\n"))
    assert main(["login", "--url", "http://testserver",
                 "--password-stdin"]) == 0


def test_no_config_error_is_friendly(monkeypatch, tmp_path, capsys):
    monkeypatch.setenv("PKM_CLI_CONFIG", str(tmp_path / "absent.json"))
    code = main(["get", "X"])
    assert code == 1
    assert "pkm login" in capsys.readouterr().err


def test_get_resolve_refs_flag(run):
    code, out, _ = run("get", "July 7th, 2026", "--resolve-refs")
    assert code == 0
    assert '"[[Attention Is All You Need]] is a [[Paper]]" ((uid_b3))' in out


def test_get_section(run):
    code, out, _ = run("get", "Machine Learning", "--section", "## Papers")
    assert code == 0
    assert "Tags:: #AI" not in out
    assert "- ## Papers" in out and "Attention" in out


def test_get_section_missing_lists_headings(run):
    code, _, err = run("get", "Machine Learning", "--section", "## Nope")
    assert code == 1
    assert "Papers" in err


def _seed_section_levels(pkm_client) -> None:
    """A page with the document-order collisions --section needs to
    disambiguate: a plain "Notes" block, an H3 "Notes", and two
    duplicate H2 "Notes" blocks."""
    pkm_client.post_ops([
        {"op": "create_page", "page_title": "Section Levels"},
        {"op": "create", "uid": "seclvlplain1", "page_title": "Section Levels",
         "parent_uid": None, "order_idx": 0, "text": "Notes"},
        {"op": "create", "uid": "seclvlh3aaaa", "page_title": "Section Levels",
         "parent_uid": None, "order_idx": 1, "text": "Notes", "heading": 3},
        {"op": "create", "uid": "seclvlh2first", "page_title": "Section Levels",
         "parent_uid": None, "order_idx": 2, "text": "Notes", "heading": 2},
        {"op": "create", "uid": "seclvlh2second", "page_title": "Section Levels",
         "parent_uid": None, "order_idx": 3, "text": "Notes", "heading": 2},
    ], batch_id="cli-get-section-levels-0001")


def test_get_section_marked_spec_selects_matching_level(run, pkm_client):
    _seed_section_levels(pkm_client)
    code, out, _ = run(
        "get", "Section Levels", "--section", "## Notes", "--uids")
    assert code == 0
    assert "^seclvlh2first" in out
    assert "^seclvlh2second" not in out


def test_get_section_marked_spec_selects_different_level_same_text(
        run, pkm_client):
    _seed_section_levels(pkm_client)
    code, out, _ = run(
        "get", "Section Levels", "--section", "### Notes", "--uids")
    assert code == 0
    assert "^seclvlh3aaaa" in out


def test_get_section_bare_spec_ignores_heading_level(run, pkm_client):
    _seed_section_levels(pkm_client)
    code, out, _ = run("get", "Section Levels", "--section", "Notes", "--uids")
    assert code == 0
    assert "^seclvlplain1" in out


def test_get_section_missing_level_lists_marked_headings_in_document_order(
        run, pkm_client):
    _seed_section_levels(pkm_client)
    code, _, err = run("get", "Section Levels", "--section", "# Notes")
    assert code == 1
    headings = err[err.index("headings: ") + len("headings: "):].strip()
    headings = headings.rstrip(")").split(", ")
    assert headings == ["### Notes", "## Notes", "## Notes"]


def test_get_depth_clips_and_filters_json(run):
    code, out, _ = run("get", "Machine Learning", "--depth", "1", "--json")
    assert code == 0
    blocks = json.loads(out)["blocks"]
    assert all(b["children"] == [] for b in blocks)


def test_get_section_on_uid_is_error(run):
    code, _, err = run("get", "uid_b3", "--section", "## Papers")
    assert code == 1
    assert "page" in err


def test_assets_search_finds_uploaded_file(run, pkm_client, tmp_path):
    f = tmp_path / "cli.png"
    f.write_bytes(b"\x89PNG\r\n\x1a\n" + b"cli")
    pkm_client.upload(f)
    code, out, _ = run("assets", "search", "cli")
    assert code == 0
    assert "cli.png" in out
    assert "pending" in out            # no describer on the test app


def test_assets_search_no_results(run):
    code, out, _ = run("assets", "search", "nothing-matches-this")
    assert code == 0
    assert out == "no assets found\n"


def test_assets_scan_disabled_exits_nonzero(run):
    code, out, err = run("assets", "scan")
    assert code == 1
    assert out == ""
    assert "OPENAI_API_KEY" in err


def test_migrate_titles_audits_by_default_and_renders_human_output(
        run, seeded_config):
    _seed_migration_graph(seeded_config.db_path)

    code, out, err = run("migrate-titles")

    assert code == 0
    assert err == ""
    assert out.startswith("# Title migration audit\n")
    assert "state: ready\n" in out
    assert "digest: d621560f1350eda15118dbd597ccd82bb80bc18ddbc646fc4165fe332dabb647\n" in out
    assert "- [11] \" Acme\" -> [10] \"Acme\"\n" in out
    assert "- [14] \"Beta \" -> [13] \" Beta \"\n" in out


def test_migrate_titles_json_audit_uses_the_validated_payload(run, seeded_config):
    _seed_migration_graph(seeded_config.db_path)
    con = sqlite3.connect(seeded_config.db_path)
    con.execute("INSERT INTO pages(id, title) VALUES (18, 'Bad #Title')")
    con.commit()
    con.close()

    code, out, err = run("migrate-titles", "--json")

    assert code == 0
    assert err == ""
    payload = json.loads(out)
    assert payload["groups"][0]["survivor"] == {"page_id": 10, "title": "Acme"}
    assert payload["blockers"] == [
        {
            "page_id": 18,
            "title": "Bad #Title",
            "reason": "forbidden_syntax",
        }
    ]


def test_migrate_titles_audit_renders_blocker_reason(run, seeded_config):
    _seed_migration_graph(seeded_config.db_path)
    con = sqlite3.connect(seeded_config.db_path)
    con.execute("INSERT INTO pages(id, title) VALUES (18, 'Bad #Title')")
    con.commit()
    con.close()

    code, out, err = run("migrate-titles")

    assert code == 0
    assert err == ""
    assert '- [18] "Bad #Title" (forbidden_syntax)\n' in out


def test_migrate_titles_apply_requires_a_digest_value(capsys):
    with pytest.raises(SystemExit) as e:
        main(["migrate-titles", "--apply"])
    assert e.value.code == 2
    assert "--apply" in capsys.readouterr().err


def test_migrate_titles_apply_renders_human_output(run, seeded_config, pkm_client):
    _seed_migration_graph(seeded_config.db_path)
    digest = pkm_client.audit_title_migration().digest

    code, out, err = run("migrate-titles", "--apply", digest)

    assert code == 0
    assert err == ""
    assert out.startswith("# Title migration applied\n")
    assert f"digest: {digest}\n" in out
    assert "groups applied: 2\n" in out
    assert "generation: " in out


def test_migrate_titles_apply_json_uses_the_validated_payload(
        run, seeded_config, pkm_client):
    _seed_migration_graph(seeded_config.db_path)
    digest = pkm_client.audit_title_migration().digest

    code, out, err = run("migrate-titles", "--apply", digest, "--json")

    assert code == 0
    assert err == ""
    payload = json.loads(out)
    assert payload["digest"] == digest
    assert payload["groups_applied"] == 2
    assert payload["pages_merged"] == 3
    assert isinstance(payload["generation"], str) and len(payload["generation"]) == 32


def test_migrate_titles_apply_preserves_existing_409_exit_behavior(
        run, seeded_config):
    _seed_migration_graph(seeded_config.db_path)

    code, out, err = run("migrate-titles", "--apply", "0" * 64)

    assert code == 1
    assert out == ""
    assert err == "409: title migration audit digest is stale\n"


def test_get_section_on_uid_shaped_page_title(run, pkm_client):
    pkm_client.create_page("Databases")
    pkm_client.post_ops([{"op": "create", "uid": "sec_head_0001",
                          "page_title": "Databases", "parent_uid": None,
                          "order_idx": 0, "text": "Vendors", "heading": 2}],
                        batch_id="t-sec-uidlike")
    code, out, _ = run("get", "Databases", "--section", "## Vendors")
    assert code == 0
    assert "- ## Vendors" in out
