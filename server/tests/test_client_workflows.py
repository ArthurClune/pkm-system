"""`pkm.client.workflows.apply_batch` fetches exactly the pages a delete
needs -- reusing a page the batch already fetched for `referenced_pages`,
and otherwise costing one `GET /api/block/{uid}` plus one page fetch per
page a delete's block turns out to live on, not one `get_block` per
deleted uid. These tests pin the fetch counts a raw `pkm batch` never
did: see `_delete_subtrees` in `pkm.client.workflows`."""
from collections.abc import Sequence

import pytest

from pkm.client.core import ApiError
from pkm.client.workflows import apply_batch
from pkm.contracts.ops import BlockUid, DeleteOp, subtree_hash


def _spy(monkeypatch, pkm_client, name):
    """Wrap `pkm_client`'s `name` method with a call-recording proxy that
    still delegates to the real implementation."""
    calls: list = []
    real = getattr(pkm_client, name)

    def _wrapped(*args, **kwargs):
        calls.append(args)
        return real(*args, **kwargs)

    monkeypatch.setattr(pkm_client, name, _wrapped)
    return calls


def _seed_leaves(pkm_client, page: str, uids: Sequence[str], batch_id: str):
    pkm_client.post_ops([
        {"op": "create", "uid": uid, "page_title": page, "parent_uid": None,
         "order_idx": i, "text": f"leaf text {uid}"}
        for i, uid in enumerate(uids)
    ], batch_id=batch_id)


def test_no_deletes_fetches_no_blocks(pkm_client, monkeypatch):
    get_block_calls = _spy(monkeypatch, pkm_client, "get_block")
    get_page_blocks_calls = _spy(monkeypatch, pkm_client, "get_page_blocks")

    ack = apply_batch(pkm_client, [
        {"command": "create", "params": {"page": "AI", "text": "hello"}},
    ])

    assert ack.skipped == []
    assert get_block_calls == []
    assert get_page_blocks_calls == [("AI",)]


def test_alias_only_deletes_fetch_nothing_extra(pkm_client, monkeypatch):
    get_block_calls = _spy(monkeypatch, pkm_client, "get_block")
    get_page_blocks_calls = _spy(monkeypatch, pkm_client, "get_page_blocks")

    ack = apply_batch(pkm_client, [
        {"command": "create",
         "params": {"page": "AI", "text": "parent", "as": "p"}},
        {"command": "delete", "params": {"uid": "{{p}}"}},
    ])

    assert ack.skipped == []
    assert get_block_calls == []
    assert get_page_blocks_calls == [("AI",)]


def test_n_deletes_on_one_unreferenced_page_cost_one_fetch_each(
        pkm_client, monkeypatch):
    uids = [BlockUid(f"delfetch0{i}") for i in range(5)]
    _seed_leaves(pkm_client, "Delete Fetch Page", uids, "seed-fetch-page")

    get_block_calls = _spy(monkeypatch, pkm_client, "get_block")
    get_page_blocks_calls = _spy(monkeypatch, pkm_client, "get_page_blocks")
    post_ops_calls = _spy(monkeypatch, pkm_client, "post_ops")

    ack = apply_batch(pkm_client, [
        {"command": "delete", "params": {"uid": uid}} for uid in uids
    ])

    assert ack.skipped == []
    assert len(get_block_calls) == 1
    assert len(get_page_blocks_calls) == 1

    [(sent_ops,)] = post_ops_calls
    deletes = {op.uid: op for op in sent_ops if isinstance(op, DeleteOp)}
    assert set(deletes) == set(uids)
    for uid in uids:
        expected = subtree_hash([(uid, f"leaf text {uid}")])
        assert deletes[uid].base_subtree_hash == expected


def test_deletes_on_a_page_the_batch_also_references_cost_nothing_extra(
        pkm_client, monkeypatch):
    # uid_b6 lives on the seeded "AI" page; a create on that same page
    # already fetches it for `referenced_pages`.
    get_block_calls = _spy(monkeypatch, pkm_client, "get_block")
    get_page_blocks_calls = _spy(monkeypatch, pkm_client, "get_page_blocks")

    ack = apply_batch(pkm_client, [
        {"command": "create", "params": {"page": "AI", "text": "companion"}},
        {"command": "delete", "params": {"uid": "uid_b6"}},
    ])

    assert ack.skipped == []
    assert get_block_calls == []
    assert get_page_blocks_calls == [("AI",)]


def test_a_404_uid_is_skipped_and_unhashed(pkm_client, monkeypatch):
    get_block_calls = _spy(monkeypatch, pkm_client, "get_block")

    ack = apply_batch(pkm_client, [
        {"command": "delete", "params": {"uid": "does-not-exist1"}},
    ])

    assert len(ack.skipped) == 1
    assert ack.skipped[0].uid == "does-not-exist1"
    assert len(get_block_calls) == 1


def test_a_non_404_get_block_error_propagates(pkm_client, monkeypatch):
    def _broken_get_block(uid):
        raise ApiError(503, "unavailable")

    monkeypatch.setattr(pkm_client, "get_block", _broken_get_block)

    with pytest.raises(ApiError) as exc:
        apply_batch(pkm_client, [
            {"command": "delete", "params": {"uid": "unreached-uid1"}},
        ])
    assert exc.value.status == 503
