"""The committed web/src/assistant/previewKeys.gen.ts must hold exactly the
keys assistant/policy.py lets each write show, or the approval card would
refuse a real write or allow a key the server never sends; and the
committed web/src/assistant/events.gen.ts must hold exactly the events
assistant/events.py sends, or the web would parse a stream the server no
longer speaks. Regenerate both with `uv run python -m pkm.regen`."""
import typing
from dataclasses import dataclass
from dataclasses import fields as dataclass_fields
from pathlib import Path
from typing import NewType

import pytest

from pkm.assistant import events
from pkm.assistant.policy import (CURRENT_TEXT_ENTRIES,
                                  SUBTREE_DELETE_ENTRIES,
                                  WRITE_PREVIEW_FIELDS)
from pkm.assistant.wire_dump import (BRANDS_TS, WireDumpError,
                                     brands_exported, events_module, main,
                                     ts_module)
from pkm.assistant.write_preview import CURRENT_EXCERPT_CHARS, WritePreview

WEB_ASSISTANT = Path(__file__).resolve().parents[2] / "web" / "src" / "assistant"
ARTIFACT = WEB_ASSISTANT / "previewKeys.gen.ts"
EVENTS_ARTIFACT = WEB_ASSISTANT / "events.gen.ts"


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


@pytest.mark.parametrize("module", ["preview-keys", "events"])
def test_comment_lines_fit_80_columns(module):
    text = _module() if module == "preview-keys" else _events()
    for line in text.splitlines():
        if line.lstrip().startswith("//"):
            assert len(line) <= 80, line


@pytest.mark.parametrize("selector", ["preview-keys", "events"])
def test_main_prints_each_artifact(capsys, selector):
    assert main([selector]) == 0
    expected = _module() if selector == "preview-keys" else _events()
    assert capsys.readouterr().out == expected


@pytest.mark.parametrize("argv", [[], ["nope"], ["events", "extra"]])
def test_main_refuses_a_missing_or_unknown_selector(capsys, argv):
    assert main(argv) == 2
    captured = capsys.readouterr()
    assert captured.out == ""
    assert "usage:" in captured.err


def test_the_preview_fields_are_exported():
    out = ts_module({}, frozenset(), frozenset(), 200, ["ops", "stamp"])
    assert ('export const PREVIEW_FIELDS: readonly string[] = '
            '["ops", "stamp"];\n') in out


def test_the_preview_fields_include_the_staleness_stamp():
    assert ('export const PREVIEW_FIELDS: readonly string[] = '
            '["ops", "summary", "writes_in_flight"];\n') in _module()


# -- the event union ------------------------------------------------------

def _events() -> str:
    return events_module(events.EVENT_NAMES,
                         typing.get_args(events.AssistantEvent),
                         brands_exported(BRANDS_TS.read_text()))


def test_committed_events_artifact_matches_the_union():
    assert EVENTS_ARTIFACT.exists(), f"missing artifact: {EVENTS_ARTIFACT}"
    assert EVENTS_ARTIFACT.read_text() == _events()


def test_every_event_has_a_wire_name_and_every_name_an_event():
    members = typing.get_args(events.AssistantEvent)
    brands = brands_exported(BRANDS_TS.read_text())
    missing = {k: v for k, v in events.EVENT_NAMES.items()
               if k is not events.Phase}
    with pytest.raises(WireDumpError, match="Phase"):
        events_module(missing, members, brands)
    with pytest.raises(WireDumpError, match="Phase"):
        events_module(events.EVENT_NAMES,
                      [m for m in members if m is not events.Phase], brands)


def test_every_event_type_is_exported_in_name_order():
    out = _events()
    names = list(events.EVENT_NAMES.values())
    assert ("export const EVENT_TYPES: ReadonlySet<string> = new Set([\n"
            + "".join(f'  "{n}",\n' for n in names) + "]);\n") in out
    positions = [out.index(f'type: "{n}"') for n in names]
    assert positions == sorted(positions)


@dataclass(frozen=True)
class _Floaty:
    ratio: float


def test_an_unmapped_field_type_is_refused():
    with pytest.raises(WireDumpError, match="ratio"):
        events_module({_Floaty: "floaty"}, [_Floaty], set())


_Ghost = NewType("_Ghost", str)


@dataclass(frozen=True)
class _Haunted:
    who: _Ghost


def test_a_brand_the_web_lacks_is_refused():
    with pytest.raises(WireDumpError, match="_Ghost"):
        events_module({_Haunted: "haunted"}, [_Haunted], {"ConfirmId"})
    out = events_module({_Haunted: "haunted"}, [_Haunted], {"_Ghost"})
    assert 'import type { _Ghost } from "../api/brands";\n' in out
    assert "    who: _Ghost;\n" in out


@dataclass(frozen=True)
class _Defaults:
    needed: str
    maybe: str | None = None
    flag: bool = False
    count: int = 0
    extra: dict[str, object] | None = None


def test_a_defaulted_field_is_optional():
    out = events_module({_Defaults: "defaults"}, [_Defaults], set())
    assert ("  | {\n"
            '    type: "defaults";\n'
            "    needed: string;\n"
            "    maybe?: string | null;\n"
            "    flag?: boolean;\n"
            "    count?: number;\n"
            "    extra?: Record<string, unknown> | null;\n"
            "  };\n") in out


def test_the_confirm_id_is_required():
    assert "    confirm_id: ConfirmId;\n" in _events()


def test_the_preview_override_names_its_import():
    out = _events()
    assert 'import type { WritePreview } from "./writePreview";\n' in out
    assert "    preview: WritePreview | null;\n" in out


@dataclass(frozen=True)
class _Previewing:
    preview: WritePreview


def test_a_preview_without_the_override_is_refused():
    with pytest.raises(WireDumpError, match="preview"):
        events_module({_Previewing: "previewing"}, [_Previewing], set())
