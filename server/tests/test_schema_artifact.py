"""The committed web/src/replica/baseSchema.gen.ts must embed exactly
schema.BASE_DDL, or the client replica's schema drifts from the server's
(spec section 3). Regenerate with:
`uv run python -m pkm.schema_dump > ../web/src/replica/baseSchema.gen.ts`."""
from pathlib import Path

from pkm.schema import BASE_DDL
from pkm.schema_dump import ts_module

ARTIFACT = (Path(__file__).resolve().parents[2]
            / "web" / "src" / "replica" / "baseSchema.gen.ts")


def test_committed_base_schema_artifact_matches_base_ddl():
    assert ARTIFACT.exists(), f"missing artifact: {ARTIFACT}"
    assert ARTIFACT.read_text() == ts_module(BASE_DDL)


def test_ts_module_escapes_template_literal_hazards():
    out = ts_module("a `tick` ${dollar} \\slash")
    assert "\\`tick\\`" in out and "\\${dollar}" in out and "\\\\slash" in out
