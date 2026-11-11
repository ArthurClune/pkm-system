# pattern: Imperative Shell
"""Dump the MIME category parity fixture for the web's Files view:
uv run python -m pkm.mime_parity_dump > ../shared/fixtures/mime_parity.json
The Files view buckets a file by web/src/views/filesCore.ts mimeCategory,
which must say what assets_core.mime_category says. Guarded by
tests/test_mime_parity_fixture.py."""
from __future__ import annotations

import json

from pkm.assets_core import MIME_POLICY, mime_category

# Types outside MIME_POLICY, so the prefix rules and the `other` fallback
# are pinned too.
EXTRA_MIME = (
    "image/avif",
    "image/x-unknown",
    "text/html",
    "text/x-python",
    "application/zip",
    "application/octet-stream",
    "application/pdf+x",
    "audio/mpeg",
    "",
)


def fixture() -> dict[str, list[dict[str, str]]]:
    mimes = [*MIME_POLICY, *EXTRA_MIME]
    return {"rows": [{"mime": m, "category": mime_category(m)} for m in mimes]}


def main() -> int:
    print(json.dumps(fixture(), indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
