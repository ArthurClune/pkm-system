# pattern: Functional Core
"""Pure logic for LLM image descriptions (pkm-zc0c): eligibility, the
OpenAI request payload, response parsing, and status derivation. All I/O
(files, HTTP, env, DB) lives in describe/openai_client.py and
describe/service.py."""
from __future__ import annotations

from typing import Any, Literal

# The image subset of ALLOWED_UPLOAD_MIME that OpenAI vision accepts
# (png/jpeg/webp/non-animated gif). HEIC and SVG are uploadable but not
# describable, so they are skipped silently — "no description" is the
# normal state for them, not a failure.
ELIGIBLE_MIME = frozenset({
    "image/png", "image/jpeg", "image/webp", "image/gif",
})

# Above this we skip rather than downscale (no Pillow dependency in v1).
# 15 MB of raw bytes base64-encodes to ~20 MB, the OpenAI request ceiling;
# anything the API still rejects surfaces as describe_error.
MAX_DESCRIBE_BYTES = 15 * 1024 * 1024
MAX_DESCRIPTION_CHARS = 1000

PROMPT = (
    "Extract all text visible in this image (titles, labels, axis text, "
    "legends, captions, code), then add one or two sentences describing "
    "what the image shows. Plain text only, no markdown. The output is "
    "indexed for search, so favour concrete words over prose.")

Action = Literal["describe", "skip", "too_large"]
Status = Literal["described", "failed", "pending"]


def describe_action(mime: str, size: int) -> Action:
    if mime not in ELIGIBLE_MIME:
        return "skip"
    if size > MAX_DESCRIBE_BYTES:
        return "too_large"
    return "describe"


def enabled_reason(api_key: str | None, config_enabled: bool) -> str | None:
    """None = feature enabled; otherwise why it is off (shown in /settings)."""
    if not config_enabled:
        return "disabled in config.json (image_descriptions=false)"
    if not api_key:
        return "OPENAI_API_KEY is not set"
    return None


def request_payload(model: str, mime: str, image_b64: str) -> dict:
    return {
        "model": model,
        "max_tokens": 500,
        "messages": [{
            "role": "user",
            "content": [
                {"type": "text", "text": PROMPT},
                {"type": "image_url",
                 "image_url": {"url": f"data:{mime};base64,{image_b64}"}},
            ],
        }],
    }


def parse_description(body: Any) -> str:
    """Extract the completion text; ValueError on any unexpected shape."""
    try:
        text = body["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError):
        raise ValueError("unexpected response shape")
    if not isinstance(text, str) or not text.strip():
        raise ValueError("empty completion")
    return text.strip()[:MAX_DESCRIPTION_CHARS]


def derive_status(description: str | None,
                  describe_error: str | None) -> Status:
    if description is not None:
        return "described"
    if describe_error is not None:
        return "failed"
    return "pending"
