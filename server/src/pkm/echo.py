# pattern: Functional Core
"""A caller-supplied string quoted into a message, bounded and on one line."""
from __future__ import annotations

import json
from collections.abc import Sequence

ECHO_LIMIT_CHARS = 80


def echo(value: str, limit: int = ECHO_LIMIT_CHARS) -> str:
    """`value` as a JSON string literal cut at `limit` characters. JSON
    escaping keeps line breaks and control characters out of the message;
    a cut value ends with its full length so the reader knows."""
    out = json.dumps(value[:limit])
    if len(value) > limit:
        out += f"… ({len(value):,} characters)"
    return out


def loc_text(loc: Sequence[object]) -> str:
    """A validation error's location as a dotted path, an overlong key
    echoed bounded."""
    return ".".join(echo(p) if isinstance(p, str)
                    and len(p) > ECHO_LIMIT_CHARS else str(p) for p in loc)
