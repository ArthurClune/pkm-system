import json
from pathlib import Path

from pkm.contracts.ops import MAX_OPS_PER_BATCH
from pkm.server.auth_gate_core import PRIVATE_BODY_MAX_BYTES

FIXTURE = (Path(__file__).resolve().parents[2] / "shared" / "fixtures"
           / "batch_limits.json")


def test_the_shared_fixture_carries_the_servers_batch_limits():
    assert json.loads(FIXTURE.read_text()) == {
        "max_ops_per_batch": MAX_OPS_PER_BATCH,
        "private_body_max_bytes": PRIVATE_BODY_MAX_BYTES,
    }
