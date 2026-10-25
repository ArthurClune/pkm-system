"""The unlink a page delete, its preview and a stale or replayed edit run
under the write lock stays linear in the text it is given.

A title ending in `[` re-forms a link to itself after each unlink
(`[[a[]]` then `[a[]]`), so a text one level deep took one pass per link.
Titles ending in `[` are refused now, wherever one ending in `]` is."""
from __future__ import annotations

from urllib.parse import quote

from scaling import loop_steps
from test_text_limits_rewrites import _page_exists, _seed

from pkm import refs, spans, text_limits, unlink
from pkm.server import ops_core
from pkm.contracts.ops import SyncSeq
from pkm.test_data.ids import (batch_id_of, client_id_of, order_idx_of,
                               seq_of, uid_of)

LEGACY = "a["
SRC = uid_of("ub_src_001")
MODULES = (unlink, refs, spans, ops_core, text_limits)
_batch_counter = 0


def chain(k: int) -> str:
    """One link to `a[`, then k spellings that each join the `a[` the
    unlink leaves into a fresh link. One level deep."""
    return "[[a[]]" + "[a[]]" * k


def _post(client, *ops, seen_seq: SyncSeq | None = None):
    global _batch_counter
    _batch_counter += 1
    body: dict[str, object] = {
        "client_id": client_id_of("unlinkbounds"),
        "batch_id": batch_id_of(f"ub_{_batch_counter:08d}"),
        "ops": list(ops)}
    if seen_seq is not None:
        body["seen_seq"] = seen_seq
    return client.post("/api/ops", json=body)


# -- titles ending in `[` -------------------------------------------------

def test_a_title_ending_in_an_open_bracket_is_refused():
    assert refs.title_syntax_reason("a[") == "forbidden_syntax"
    assert refs.title_syntax_reason(" a[ ") == "forbidden_syntax"
    assert refs.title_syntax_reason("[") == "forbidden_syntax"
    assert refs.title_syntax_reason("a[ b") is None
    assert refs.title_syntax_reason("[a") is None


def test_ops_refuse_a_link_or_page_title_ending_in_an_open_bracket(client):
    assert client.post("/api/pages", json={"title": "Src"}).status_code < 300
    for op in ({"op": "create", "uid": SRC, "page_title": "Src",
                "parent_uid": None, "order_idx": order_idx_of(0),
                "text": "see [[a[]]"},
               {"op": "create_page", "page_title": "a["}):
        r = _post(client, op)
        assert r.status_code == 400, r.text[:300]
        assert "unsupported" in r.text
    assert client.get(f"/api/page/{quote(LEGACY)}").status_code == 404


def test_a_sidebar_pin_of_a_title_ending_in_an_open_bracket_is_422(client):
    r = client.post("/api/sidebar", json={"title": "a["})
    assert r.status_code == 422, r.text


def test_a_stale_batch_linking_a_legacy_title_is_refused_on_arrival(
        client, seeded_config):
    # The batch predates the delete of `a[` (seen_seq 0), so its text
    # would be unlinked under the lock, one link per pass. It names a
    # refused title, which the client sent, so it is refused before the
    # lock.
    assert client.post("/api/pages", json={"title": "Src"}).status_code < 300
    _seed(seeded_config, [], pages=(LEGACY,))
    assert client.delete(f"/api/page/{quote(LEGACY)}").status_code == 200

    def run(k: int) -> tuple[int, int]:
        got = []
        work = loop_steps(MODULES, lambda: got.append(_post(
            client, {"op": "create", "uid": uid_of(f"ub_stale_{k}"),
                     "page_title": "Src",
                     "parent_uid": None, "order_idx": order_idx_of(0),
                     "text": chain(k)}, seen_seq=seq_of(0))))
        return work, got[0].status_code

    (small, _), (large, status) = run(500), run(2000)
    assert large < 6 * small, (small, large)
    assert status == 400
    assert not _page_exists(seeded_config, LEGACY)
