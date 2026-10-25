"""The committed web/src/assistant/previewKeys.gen.ts must hold exactly the
keys assistant/policy.py lets each write show, or the approval card would
refuse a real write or allow a key the server never sends. Regenerate with
`uv run python -m pkm.assistant.preview_keys_dump` into that file."""
from dataclasses import fields as dataclass_fields
from pathlib import Path

import pytest

from pkm.assistant.policy import (CURRENT_TEXT_ENTRIES,
                                  SUBTREE_DELETE_ENTRIES,
                                  WRITE_PREVIEW_FIELDS)
from pkm.assistant.preview_keys_dump import main, ts_module
from pkm.assistant.write_preview import CURRENT_EXCERPT_CHARS, WritePreview

ARTIFACT = (Path(__file__).resolve().parents[2]
            / "web" / "src" / "assistant" / "previewKeys.gen.ts")


def _module() -> str:
    return ts_module(WRITE_PREVIEW_FIELDS, CURRENT_TEXT_ENTRIES,
                     SUBTREE_DELETE_ENTRIES, CURRENT_EXCERPT_CHARS,
                     [f.name for f in dataclass_fields(WritePreview)])


def test_committed_preview_keys_artifact_matches_the_table():
    assert ARTIFACT.exists(), f"missing artifact: {ARTIFACT}"
    assert ARTIFACT.read_text() == _module()


def test_entries_sharing_a_label_merge_their_keys():
    fields = {"a": ("same", ("uid", "mark"), ("text",)),
              "b": ("same", ("uid", "page"), ("items",))}
    out = ts_module(fields, frozenset({"a", "b"}), frozenset(), 200, [])
    assert ('["same", { targets: ["uid", "mark", "page"], '
            'content: ["text", "items"], current: true, '
            'descendants: false }],') in out
    assert out.count('["same"') == 1


def test_entries_are_sorted_by_label():
    fields = {"z": ("zeta", ("uid",), ()), "a": ("alpha", ("uid",), ())}
    out = ts_module(fields, frozenset(), frozenset(), 200, [])
    assert out.index('["alpha"') < out.index('["zeta"')


def test_flags_follow_the_entry_sets():
    fields = {"d": ("delete", ("uid",), ()), "s": ("save", ("page",), ())}
    out = ts_module(fields, frozenset({"d"}), frozenset({"d"}), 200, [])
    assert ('["delete", { targets: ["uid"], content: [], current: true, '
            'descendants: true }],') in out
    assert ('["save", { targets: ["page"], content: [], current: false, '
            'descendants: false }],') in out


@pytest.mark.parametrize("current, subtree", [
    (frozenset({"a"}), frozenset()),
    (frozenset({"a", "b"}), frozenset({"a"})),
])
def test_entries_sharing_a_label_must_agree_on_their_flags(current, subtree):
    fields = {"a": ("same", ("uid",), ()), "b": ("same", ("uid",), ())}
    with pytest.raises(ValueError, match="same"):
        ts_module(fields, current, subtree, 200, [])


def test_the_excerpt_clip_is_exported():
    out = ts_module({}, frozenset(), frozenset(), 37, [])
    assert "export const CURRENT_EXCERPT_CHARS = 37;\n" in out


def test_comment_lines_fit_80_columns():
    for line in _module().splitlines():
        if line.startswith("//"):
            assert len(line) <= 80, line


def test_main_prints_the_module(capsys):
    assert main() == 0
    assert capsys.readouterr().out == _module()


def test_the_preview_fields_are_exported():
    out = ts_module({}, frozenset(), frozenset(), 200, ["ops", "stamp"])
    assert ('export const PREVIEW_FIELDS: readonly string[] = '
            '["ops", "stamp"];\n') in out


def test_the_preview_fields_include_the_staleness_stamp():
    assert ('export const PREVIEW_FIELDS: readonly string[] = '
            '["ops", "summary", "writes_in_flight"];\n') in _module()
