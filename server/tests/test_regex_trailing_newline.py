"""A value with a trailing newline is not the value: every anchored regex in
the product refuses it, where `$` would have accepted it."""
import pytest

from pkm.backup.rotation import prune_list
from pkm.batch import _resolve_alias
from pkm.changed import _DATE_RE
from pkm.contracts.daily import date_for_title
from pkm.importer.mermaid import _TRIGGER
from pkm.planning import BuildError, parse_uid_spec, resolve_parent, split_heading
from pkm.test_data.ids import uid_of
from pkm.unlink import _ALIAS_LABEL


def test_split_heading_keeps_trailing_newline_text_verbatim():
    assert split_heading("## Overview") == ("Overview", 2)
    assert split_heading("## Overview\n") == ("## Overview\n", None)


def test_uid_spec_with_trailing_newline_is_not_a_uid_spec():
    assert parse_uid_spec("((abcdef))") == uid_of("abcdef")
    assert parse_uid_spec("((abcdef))\n") is None


def test_heading_parent_spec_with_trailing_newline_is_unrecognized():
    with pytest.raises(BuildError, match="unrecognized parent spec"):
        resolve_parent([], "## Heading\n")


def test_alias_spec_with_trailing_newline_is_not_an_alias():
    assert _resolve_alias("{{a}}\n", {}) == "{{a}}\n"
    with pytest.raises(BuildError, match="unknown alias: a"):
        _resolve_alias("{{a}}", {})


def test_backup_name_with_trailing_newline_is_left_alone():
    assert prune_list(["pkm-2026-07-09.sqlite3\n"], keep_daily=0) == []


def test_daily_title_with_trailing_newline_is_not_a_date():
    assert date_for_title("October 21st, 2026") is not None
    assert date_for_title("October 21st, 2026\n") is None


def test_date_word_fullmatch_refuses_trailing_newline():
    assert _DATE_RE.fullmatch("2026-10-21")
    assert _DATE_RE.fullmatch("2026-10-21\n") is None


def test_mermaid_trigger_still_tolerates_trailing_whitespace():
    assert _TRIGGER.match("{{[[mermaid]]}}\n")
    assert _TRIGGER.match("  {{mermaid}}  ")


def test_alias_label_needs_the_paren_at_the_search_end():
    assert _ALIAS_LABEL.search("[x](", 0, 4)
    assert _ALIAS_LABEL.search("[x](\n", 0, 5) is None
