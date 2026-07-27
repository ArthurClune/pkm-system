import pytest

from pkm.assistant.policy import (
    DEFAULT_MODEL,
    SYSTEM_PROMPT,
    all_tool_names,
    classify_tool,
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
    }
    assert len(all_tool_names()) == 10


def test_classify_tool():
    assert classify_tool("mcp__pkm__search") == "read"
    assert classify_tool("mcp__pkm__batch") == "write"
    assert classify_tool("Bash") == "unknown"
    assert classify_tool("mcp__other__search") == "unknown"
    assert classify_tool("mcp__pkm__made_up") == "unknown"


def test_short_tool_name():
    assert short_tool_name("mcp__pkm__get_page") == "get_page"
    assert short_tool_name("Bash") == "Bash"


def test_resolve_model():
    assert resolve_model(None) == DEFAULT_MODEL == "sonnet"
    assert resolve_model("opus") == "opus"
    assert resolve_model("haiku") == "haiku"
    with pytest.raises(ValueError):
        resolve_model("gpt-4o")
    with pytest.raises(ValueError):
        resolve_model("")


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
    out = ops_preview("batch", {"ops": [{"op": "move", "uid": "abc123"}, {"op": "delete", "uid": "def456"}]})
    assert "2 operation" in out
    assert "abc123" in out and "def456" in out


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
