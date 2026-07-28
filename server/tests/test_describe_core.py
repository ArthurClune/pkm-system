import pytest

from pkm.describe.core import (MAX_DESCRIPTION_CHARS, derive_status,
                               describe_action, enabled_reason,
                               parse_description, request_payload)


@pytest.mark.parametrize("mime,size,expected", [
    ("image/png", 100, "describe"),
    ("image/jpeg", 100, "describe"),
    ("image/webp", 100, "describe"),
    ("image/gif", 100, "describe"),
    ("image/svg+xml", 100, "skip"),        # can script; also not vision-supported
    ("image/heic", 100, "skip"),           # uploadable but OpenAI vision rejects it
    ("application/pdf", 100, "skip"),
    ("text/csv", 100, "skip"),
    ("image/png", 15 * 1024 * 1024 + 1, "too_large"),
    ("image/png", 15 * 1024 * 1024, "describe"),
])
def test_describe_action(mime, size, expected):
    assert describe_action(mime, size) == expected


_NO_KEY_REASON = "no openai_key file and OPENAI_API_KEY is not set"


def test_enabled_reason():
    assert enabled_reason("sk-x", True) is None
    assert enabled_reason(None, True) == _NO_KEY_REASON
    assert enabled_reason("", True) == _NO_KEY_REASON
    assert (enabled_reason("sk-x", False)
            == "disabled in config.json (image_descriptions=false)")
    # config off wins over missing key: the deliberate switch is the reason
    reason = enabled_reason(None, False)
    assert reason is not None and "config" in reason


def test_request_payload_shape():
    p = request_payload("gpt-4o-mini", "image/png", "QUJD")
    assert p["model"] == "gpt-4o-mini"
    content = p["messages"][0]["content"]
    assert content[0]["type"] == "text"
    assert content[1]["image_url"]["url"] == "data:image/png;base64,QUJD"


def test_parse_description_happy_path():
    body = {"choices": [{"message": {"content": "  a graph of CPU load  "}}]}
    assert parse_description(body) == "a graph of CPU load"


def test_parse_description_truncates():
    body = {"choices": [{"message": {"content": "x" * 5000}}]}
    assert len(parse_description(body)) == MAX_DESCRIPTION_CHARS


@pytest.mark.parametrize("body", [
    {}, {"choices": []}, {"choices": [{"message": {}}]},
    {"choices": [{"message": {"content": ""}}]},
    {"choices": [{"message": {"content": "   "}}]},
    {"choices": [{"message": {"content": 42}}]},
    "not a dict", None,
])
def test_parse_description_rejects_malformed(body):
    with pytest.raises(ValueError):
        parse_description(body)


def test_derive_status():
    assert derive_status("text", None) == "described"
    assert derive_status(None, "http 429") == "failed"
    assert derive_status(None, None) == "pending"
    # description wins if both are somehow set (a retry that succeeded)
    assert derive_status("text", "old error") == "described"
