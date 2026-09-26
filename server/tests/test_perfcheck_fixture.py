from collections import Counter

from pkm.contracts.daily import title_for_date
from pkm.contracts.ops import OpBatch
from perfcheck.fixture import (BIG_PAGE, FROZEN_TODAY, HUBS, PHRASE, RARE_TERM,
                               generate)


def creates(fx):
    return [op for b in fx.batches for op in b.ops if op["op"] == "create"]


def test_same_seed_same_fixture():
    assert generate(1, 0.02) == generate(1, 0.02)
    assert generate(1, 0.02) != generate(2, 0.02)


def test_full_scale_shape():
    fx = generate(1, 1.0)
    cs = creates(fx)
    assert 45_000 <= len(cs) <= 55_000
    per_page = Counter(op["page_title"] for op in cs)
    assert 3_500 <= len(per_page) <= 4_600
    assert per_page[BIG_PAGE] == 1_200
    journal = [t for t in per_page if t.endswith(", 2026") or t.endswith(", 2025")]
    assert len(journal) >= 365
    assert title_for_date(FROZEN_TODAY) in per_page  # GET /api/journal must never create a page
    for hub in HUBS:
        backlinks = sum(1 for op in cs if f"[[{hub}]]" in op["text"])
        assert 150 <= backlinks <= 450, hub
    assert sum(1 for op in cs if RARE_TERM in op["text"]) == 3
    assert sum(1 for op in cs if PHRASE in op["text"]) == 12
    assert sum(1 for op in cs if op["text"].startswith("{{[[TODO]]}}")) > 500
    ref_counts = Counter(u for op in cs for u in _refs(op["text"]))
    assert ref_counts[fx.landmarks.popular_uid] >= 50


def _refs(text):
    import re
    return re.findall(r"\(\(([a-zA-Z0-9_-]{6,})\)\)", text)


def test_every_batch_validates_and_parents_precede_children():
    fx = generate(1, 0.02)
    seen: set[str] = set()
    for i, b in enumerate(fx.batches):
        assert len(b.ops) <= 400
        OpBatch.model_validate({"client_id": "perf-fixture",
                                "batch_id": f"fixture-{i:06d}", "ops": list(b.ops)})
        for op in b.ops:
            if op["op"] == "create":
                assert op["parent_uid"] is None or op["parent_uid"] in seen
                seen.add(op["uid"])


def test_batches_are_time_ordered_and_not_after_frozen_now():
    from perfcheck.fixture import FROZEN_NOW_MS
    fx = generate(1, 0.02)
    times = [b.now_ms for b in fx.batches]
    assert times == sorted(times)
    assert times[-1] <= FROZEN_NOW_MS


def test_landmarks_exist():
    fx = generate(1, 0.02)
    uids = {op["uid"] for op in creates(fx)}
    lm = fx.landmarks
    assert {lm.popular_uid, lm.move_uid, lm.edit_uid} <= uids
    assert set(lm.ref_uids) <= uids and len(lm.ref_uids) == 30
    kids = [op for op in creates(fx) if op["parent_uid"] == lm.move_uid]
    assert kids, "move_uid must have children so the move is a subtree move"
    assert fx.assets and fx.sidebar


def test_edits_follow_their_creates():
    fx = generate(1, 0.02)
    created: dict[str, int] = {}
    for b in fx.batches:
        for op in b.ops:
            if op["op"] == "create":
                created[op["uid"]] = b.now_ms
            else:
                assert op["uid"] in created and created[op["uid"]] < b.now_ms
