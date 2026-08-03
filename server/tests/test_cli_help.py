import pytest

from pkm.cli.main import main

VERBS = ["login", "get", "search", "refs", "query", "todos",
         "save", "update", "upload", "batch", "assets",
         "migrate-titles"]


@pytest.mark.parametrize("verb", VERBS)
def test_every_verb_help_has_example(verb, capsys):
    with pytest.raises(SystemExit):
        main([verb, "--help"])
    out = capsys.readouterr().out
    assert "example" in out.lower(), f"{verb} --help has no example"


def test_batch_help_is_self_sufficient(capsys):
    with pytest.raises(SystemExit):
        main(["batch", "--help"])
    out = capsys.readouterr().out
    for needle in ["create", "todo", "update", "move", "delete", "outline",
                   "as", "{{alias}}", "index", "## Heading", "((uid))",
                   '"command"', "params"]:
        assert needle in out, f"batch --help missing {needle!r}"


def test_get_help_documents_target_forms(capsys):
    with pytest.raises(SystemExit):
        main(["get", "--help"])
    out = capsys.readouterr().out
    for needle in ["today", "uid", "--section", "--depth", "--resolve-refs"]:
        assert needle in out


def test_get_help_documents_section_level_semantics(capsys):
    with pytest.raises(SystemExit):
        main(["get", "--help"])
    out = capsys.readouterr().out
    for needle in ["level and exact text", "bare text", "regardless of heading"]:
        assert needle in out, f"get --help omits {needle!r}"


def test_migrate_titles_help_is_self_sufficient_about_manual_audit_and_apply(capsys):
    with pytest.raises(SystemExit):
        main(["migrate-titles", "--help"])
    out = capsys.readouterr().out
    for needle in [
        "pkm migrate-titles",
        "--apply DIGEST",
        "--json",
        "does not run automatically on startup",
        "audit by default",
    ]:
        assert needle in out


# Needles unique to the heading-*writing* prose added for pkm-8m94 -- not
# just "heading"/"###", which `batch --help` already contained via the
# unrelated parent-spec heading-*matching* prose ("a different level, e.g.
# '###', makes its own heading"). Each needle below only exists if the
# heading-writing sentence for that verb/command is present.
_HEADING_LEVEL_NEEDLES = {
    "save": ['becomes a real heading block at'],
    "update": ['makes the block a heading at'],
    "batch": ['A text beginning "# ", "## " or "### " becomes a',
              'sets the heading level; text',
              'An item text beginning "# ",'],
}


@pytest.mark.parametrize("verb", ["save", "update", "batch"])
def test_write_verb_help_documents_heading_levels(verb, capsys):
    with pytest.raises(SystemExit):
        main([verb, "--help"])
    out = capsys.readouterr().out
    for needle in _HEADING_LEVEL_NEEDLES[verb]:
        assert needle in out, f"{verb} --help omits {needle!r}"
