import pytest

from pkm.cli.main import main

VERBS = ["login", "get", "search", "refs", "query", "todos",
         "save", "update", "upload", "batch", "assets"]


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


@pytest.mark.parametrize("verb", ["save", "update", "batch"])
def test_write_verb_help_documents_heading_levels(verb, capsys):
    with pytest.raises(SystemExit):
        main([verb, "--help"])
    out = capsys.readouterr().out
    assert "heading" in out.lower(), f"{verb} --help omits heading levels"
    assert "###" in out, f"{verb} --help omits the heading marker syntax"
