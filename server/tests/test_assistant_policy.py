import re

import pytest

from pkm.assistant.policy import (
    SYSTEM_PROMPT,
    all_tool_names,
    available_models,
    classify_tool,
    default_model,
    mcp_tool_name,
    ops_preview,
    read_tool_names,
    resolve_model,
    short_tool_name,
    tool_summary,
)


def test_tool_names_namespaced():
    assert mcp_tool_name("search") == "mcp__pkm__search"
    assert "mcp__pkm__save_note" in all_tool_names()
    assert set(read_tool_names()) == {
        "mcp__pkm__get_page", "mcp__pkm__get_block", "mcp__pkm__search",
        "mcp__pkm__query", "mcp__pkm__backlinks", "mcp__pkm__todos",
        "mcp__pkm__search_assets",
    }
    assert len(all_tool_names()) == 11


def test_classify_tool():
    assert classify_tool("mcp__pkm__search") == "read"
    assert classify_tool("mcp__pkm__batch") == "write"
    assert classify_tool("Bash") == "unknown"
    assert classify_tool("mcp__other__search") == "unknown"
    assert classify_tool("mcp__pkm__made_up") == "unknown"


def test_search_assets_is_a_read_tool():
    assert classify_tool(mcp_tool_name("search_assets")) == "read"


def test_short_tool_name():
    assert short_tool_name("mcp__pkm__get_page") == "get_page"
    assert short_tool_name("Bash") == "Bash"


def test_resolve_model():
    assert resolve_model("sonnet") == "sonnet"
    assert resolve_model("opus") == "opus"
    assert resolve_model("haiku") == "haiku"
    assert resolve_model("glm") == "glm"
    with pytest.raises(ValueError):
        resolve_model("gpt-4o")
    with pytest.raises(ValueError):
        resolve_model("")


def test_default_model_prefers_glm_when_offered():
    # pkm-452i: glm is the preferred default, but it is only servable when a
    # z.ai key is configured -- a keyless deployment must default to sonnet
    # rather than 400 every default create.
    assert default_model(available_models(zai_configured=True)) == "glm"
    assert default_model(available_models(zai_configured=False)) == "sonnet"


def test_available_models_includes_glm_only_when_zai_configured():
    with_key = available_models(zai_configured=True)
    without_key = available_models(zai_configured=False)
    assert "glm" in with_key
    assert "glm" not in without_key
    # the Claude trio and the default are offered either way
    for models in (with_key, without_key):
        assert default_model(models) in models
        assert {"sonnet", "opus", "haiku"} <= set(models)


def test_tool_summary():
    assert tool_summary("search", {"q": "quarterly review"}) == 'searching "quarterly review"'
    assert tool_summary("get_page", {"title": "Projects"}) == 'reading page "Projects"'
    assert tool_summary("backlinks", {"title": "Alice"}) == 'backlinks for "Alice"'
    assert tool_summary("todos", {}) == "listing TODOs"
    # unknown keys fall back to the verb name
    assert tool_summary("get_block", {}) == "get_block"


def test_ops_preview_save_note():
    out = ops_preview("save_note", {"title": "Demo", "content": "hello world"})
    assert "save_note" in out and "Demo" in out


def test_ops_preview_batch_lists_ops():
    # pkm-y3rr: the payload shape here must match mcp.server.batch's real
    # signature -- `commands`, each {"command": ..., "params": {...}}. An
    # earlier version of this test invented an `ops` key the tool cannot emit,
    # so it passed while every real approval card rendered "0 operation(s)".
    out = ops_preview("batch", {"commands": [
        {"command": "move", "params": {"uid": "abc123", "page": "Demo"}},
        {"command": "delete", "params": {"uid": "def456"}},
    ]})
    assert "2 operation" in out
    assert "abc123" in out and "def456" in out
    assert "move" in out and "delete" in out


def test_ops_preview_batch_never_silently_empty():
    # A batch whose argument shape we don't recognise (a renamed parameter,
    # a future signature) must still show the user what they are approving:
    # falling back to the verbose generic rendering is safe, claiming there is
    # nothing to approve is not.
    out = ops_preview("batch", {"operations": [{"command": "delete", "params": {"uid": "zzz999"}}]})
    assert "0 operation" not in out
    assert "zzz999" in out


def test_ops_preview_does_not_clip_moderate_values():
    # pkm-c98s item 6: the original 120-char clip made users approve writes
    # they couldn't fully see. ops_preview (unlike tool_summary) now only
    # clips pathologically long values, so ordinary note text is shown
    # in full.
    text = "x" * 500
    out = ops_preview("update_block", {"uid": "abc123", "text": text})
    assert text in out


def test_ops_preview_still_clips_pathologically_long_values():
    out = ops_preview("update_block", {"uid": "abc123", "text": "x" * 20_000})
    assert len(out) < 5000
    assert "…" in out


def test_tool_summary_still_clips_at_120_for_the_running_indicator():
    # tool_summary feeds the transient "…searching ..." line next to a
    # running tool, not the write-approval preview -- keep it short.
    out = tool_summary("search", {"q": "x" * 500})
    assert len(out) < 200


def test_system_prompt_mentions_tools_and_confirm():
    assert "search" in SYSTEM_PROMPT
    assert "backlinks" in SYSTEM_PROMPT
    assert "confirm" in SYSTEM_PROMPT.lower()


def test_system_prompt_tells_model_to_cite_clickable_links():
    # pkm-hjcc: the web panel renders bare /assets/<sha>/<filename> URLs and
    # ((uid)) block refs as clickable links (pkm-gdi5), but only if the model
    # emits them in its FIRST answer -- the prompt must say so explicitly.
    assert "/assets/" in SYSTEM_PROMPT
    assert "((" in SYSTEM_PROMPT


def test_system_prompt_warns_against_caret_in_block_ref_citations():
    # pkm-wx86: tool output shows blocks with trailing ^uid markers; GLM
    # copied the marker verbatim, citing ((^uid)), which the web grammar
    # rejects. The prompt must show the wrong form explicitly.
    assert "((^" in SYSTEM_PROMPT


def test_system_prompt_has_no_tool_count_to_drift():
    # The prompt once said "ten PKM verbs" while listing eleven tools; a
    # count-free sentence can't drift when tools are added.
    assert re.search(r"\b(ten|eleven|twelve)\b", SYSTEM_PROMPT.lower()) is None
