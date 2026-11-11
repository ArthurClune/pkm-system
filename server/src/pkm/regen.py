# pattern: Imperative Shell
"""Regenerate every checked-in generated artifact and parity fixture:
uv run python -m pkm.regen
Run from anywhere; each step runs in the directory it expects, writes its
target itself and stops the run on its first failure. A stdout dump is
written only when it succeeds, so a failure never leaves an emptied
artifact. `tag_chars_dump --table` is not a step: it rewrites the table the
other dumps import, and only a Unicode version move calls for it."""
from __future__ import annotations

import os
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]


@dataclass(frozen=True)
class Step:
    name: str
    module: str | None = None
    args: tuple[str, ...] = ()
    # stdout of `module` is written here, relative to the repo root; a module
    # that writes its own files has none
    target: str | None = None
    command: tuple[str, ...] = ()
    env: str | None = None


STEPS = (
    Step("openapi", "pkm.server.openapi_dump", target="web/src/api/openapi.json"),
    Step("gen-types", command=("pnpm", "gen-types")),
    Step("schema", "pkm.schema_dump", target="web/src/replica/baseSchema.gen.ts"),
    Step("rows", "pkm.rows_dump"),
    Step("preview-keys", "pkm.assistant.wire_dump", args=("preview-keys",),
         target="web/src/assistant/previewKeys.gen.ts"),
    Step("assistant-events", "pkm.assistant.wire_dump", args=("events",),
         target="web/src/assistant/events.gen.ts"),
    Step("tag-chars", "pkm.tag_chars_dump", target="web/src/grammar/tagChars.gen.ts"),
    Step("title-whitespace", "pkm.title_whitespace_dump",
         target="web/src/grammar/titleWhitespace.gen.ts"),
    Step("refs-parity", "pkm.refs_parity_dump", target="shared/fixtures/refs_parity.json"),
    Step("title-parity", "pkm.title_parity_dump", target="shared/fixtures/title_parity.json"),
    Step("text-limits-parity", "pkm.text_limits_parity_dump",
         target="shared/fixtures/text_limits_parity.json"),
    Step("shim-parity", "pkm.server.shim_parity_dump",
         target="shared/fixtures/shim_parity.json"),
    Step("text-hash-parity",
         command=("pnpm", "vitest", "run", "src/replica/textHashParity.test.ts"),
         env="UPDATE_TEXT_HASH_FIXTURE"),
    Step("local-links-parity",
         command=("pnpm", "vitest", "run", "src/outline/localLinksParity.test.ts"),
         env="UPDATE_LOCAL_LINKS_FIXTURE"),
    Step("upload-links-parity",
         command=("pnpm", "vitest", "run", "src/sync/assetsParity.test.ts"),
         env="UPDATE_UPLOAD_LINKS_FIXTURE"),
)


def run_step(step: Step) -> int:
    env = {**os.environ, **({step.env: "1"} if step.env else {})}
    if step.module is None:
        return subprocess.run(step.command, cwd=REPO / "web", env=env).returncode
    done = subprocess.run([sys.executable, "-m", step.module, *step.args],
                          cwd=REPO / "server", env=env, capture_output=step.target is not None)
    if done.returncode == 0 and step.target is not None:
        (REPO / step.target).write_bytes(done.stdout)
        print(step.target)
    elif done.returncode != 0 and step.target is not None:
        sys.stderr.buffer.write(done.stderr)
    return done.returncode


def main() -> int:
    for step in STEPS:
        code = run_step(step)
        if code != 0:
            print(f"regen: step {step.name!r} failed with exit {code}", file=sys.stderr)
            return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
