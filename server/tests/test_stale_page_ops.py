"""A batch built before its device saw a page delete cannot re-create the
page: its content is parked in today's daily note and its links go plain."""
from __future__ import annotations

import sqlite3
from datetime import date

from pkm.contracts.daily import title_for_date
from pkm.contracts.ops import text_hash

TITLE = "Machine Learning"
_counter = 0


def _seq(config) -> int:
    con = sqlite3.connect(config.db_path)
    try:
        return con.execute("SELECT MAX(seq) FROM changes").fetchone()[0]
    finally:
        con.close()


def _post(client, *ops, seen_seq=None):
    global _counter
    _counter += 1
    body = {"client_id": "c1", "batch_id": f"stale_batch_{_counter:06d}",
            "ops": list(ops)}
    if seen_seq is not None:
        body["seen_seq"] = seen_seq
    return client.post("/api/ops", json=body)


def _delete_ml(client, config) -> int:
    seen = _seq(config)
    assert client.delete(f"/api/page/{TITLE}").status_code == 200
    return seen


def _conflicts(client):
    r = client.get(f"/api/page/{title_for_date(date.today())}")
    if r.status_code == 404:
        return []
    return [(b["text"], [c["text"] for c in b["children"]])
            for b in r.json()["blocks"]
            if b["text"].startswith("[[conflict]]")]


def _text(config, uid):
    con = sqlite3.connect(config.db_path)
    try:
        row = con.execute("SELECT text FROM blocks WHERE uid = ?",
                          (uid,)).fetchone()
        return row[0] if row else None
    finally:
        con.close()


def _create(uid, text, parent=None, title=TITLE, idx=0):
    return {"op": "create", "uid": uid, "page_title": title,
            "parent_uid": parent, "order_idx": idx, "text": text}


def test_stale_top_level_create_is_parked_and_page_stays_deleted(
        client, seeded_config):
    seen = _delete_ml(client, seeded_config)
    r = _post(client, _create("stale001", "offline thought"), seen_seq=seen)
    assert r.status_code == 200
    assert r.json()["skipped"][0]["reason"] == "page_deleted"
    assert client.get(f"/api/page/{TITLE}").status_code == 404
    [(header, children)] = _conflicts(client)
    assert header.startswith("[[conflict]] `Machine Learning`")
    assert children == ["offline thought"]
    assert _text(seeded_config, "stale001") is None


def test_stale_top_level_create_children_group_under_its_header(
        client, seeded_config):
    seen = _delete_ml(client, seeded_config)
    r = _post(client, _create("stale001", "parent text"),
              _create("stale002", "child text", parent="stale001"),
              seen_seq=seen)
    assert r.status_code == 200
    [(header, children)] = _conflicts(client)
    assert header.startswith("[[conflict]] `Machine Learning`")
    assert children == ["parent text", "child text"]
    assert client.get(f"/api/page/{TITLE}").status_code == 404


def test_stale_top_level_move_leaves_block_and_notes_it(
        client, seeded_config):
    seen = _delete_ml(client, seeded_config)
    r = _post(client, {"op": "move", "uid": "uid_b6", "parent_uid": None,
                       "order_idx": 0, "page_title": TITLE}, seen_seq=seen)
    assert r.status_code == 200
    assert r.json()["skipped"][0]["reason"] == "page_deleted"
    assert client.get(f"/api/page/{TITLE}").status_code == 404
    con = sqlite3.connect(seeded_config.db_path)
    assert con.execute("SELECT page_id FROM blocks WHERE uid = 'uid_b6'"
                       ).fetchone()[0] == 2
    con.close()
    assert len(_conflicts(client)) == 1


def test_stale_create_page_is_dropped(client, seeded_config, monkeypatch):
    seen = _delete_ml(client, seeded_config)
    sent = []
    hub = client.app.state.hub

    async def capture(msg):
        sent.append(msg)

    monkeypatch.setattr(hub, "broadcast", capture)
    r = _post(client, {"op": "create_page", "page_title": TITLE},
              seen_seq=seen)
    assert r.status_code == 200
    assert r.json()["skipped"] == []
    assert client.get(f"/api/page/{TITLE}").status_code == 404
    assert sent[0]["ops"] == []


def test_stale_link_in_create_under_live_parent_becomes_plain(
        client, seeded_config):
    seen = _delete_ml(client, seeded_config)
    r = _post(client, _create("stale001", "about [[Machine Learning]]",
                              parent="uid_b4", title="July 7th, 2026"),
              seen_seq=seen)
    assert r.status_code == 200
    assert r.json()["skipped"] == []
    assert _text(seeded_config, "stale001") == "about Machine Learning"
    assert client.get(f"/api/page/{TITLE}").status_code == 404


def test_stale_link_in_unhashed_and_hashed_update_text_becomes_plain(
        client, seeded_config):
    base = "Studying [[Machine Learning]] today"
    seen = _delete_ml(client, seeded_config)
    # the delete already unlinked uid_b4: the hashed edit replays the
    # rewrite, then the stale unlink runs too -- neither is a conflict
    r = _post(client,
              {"op": "update_text", "uid": "uid_b4",
               "text": base + "!", "base_text_hash": text_hash(base)},
              {"op": "update_text", "uid": "uid_b5",
               "text": "see [[Machine Learning]]"},
              seen_seq=seen)
    assert r.status_code == 200
    assert r.json()["skipped"] == []
    assert _text(seeded_config, "uid_b4") == "Studying Machine Learning today!"
    assert _text(seeded_config, "uid_b5") == "see Machine Learning"
    assert _conflicts(client) == []
    assert client.get(f"/api/page/{TITLE}").status_code == 404


def _update(uid, text, base):
    return {"op": "update_text", "uid": uid, "text": text,
            "base_text_hash": text_hash(base)}


def test_chained_hashed_edits_after_a_stale_unlink_apply_clean(
        client, seeded_config):
    linked = "see [[Machine Learning]]"
    seen = _delete_ml(client, seeded_config)
    r = _post(client,
              _create("stale001", "", parent="uid_b4", title="July 7th, 2026"),
              _update("stale001", linked, ""),
              _update("stale001", linked + " tomorrow", linked),
              seen_seq=seen)
    assert r.status_code == 200
    assert r.json()["skipped"] == []
    assert _text(seeded_config, "stale001") == "see Machine Learning tomorrow"
    assert _conflicts(client) == []


def test_hashed_edit_after_a_stale_create_with_a_link_applies_clean(
        client, seeded_config):
    linked = "about [[Machine Learning]]"
    seen = _delete_ml(client, seeded_config)
    r = _post(client,
              _create("stale001", linked, parent="uid_b4",
                      title="July 7th, 2026"),
              _update("stale001", linked + " more", linked),
              seen_seq=seen)
    assert r.status_code == 200
    assert _text(seeded_config, "stale001") == "about Machine Learning more"
    assert _conflicts(client) == []


def test_parked_orphan_edit_text_is_unlinked(client, seeded_config):
    seen = _delete_ml(client, seeded_config)
    r = _post(client,
              {"op": "update_text", "uid": "uid_b1",
               "text": "re-edit [[Machine Learning]]",
               "base_text_hash": text_hash("Tags:: #AI")},
              seen_seq=seen)
    assert r.status_code == 200
    [(_, children)] = _conflicts(client)
    assert children == ["re-edit Machine Learning"]
    assert client.get(f"/api/page/{TITLE}").status_code == 404


def test_same_device_link_right_after_its_own_delete_goes_plain(
        client, seeded_config):
    # the device deleted the page itself, then linked it again offline
    seen = _seq(seeded_config)
    assert client.delete(f"/api/page/{TITLE}").status_code == 200
    r = _post(client, _create("stale001", "back to [[Machine Learning]]",
                              parent="uid_b4", title="July 7th, 2026"),
              seen_seq=seen)
    assert r.status_code == 200
    assert _text(seeded_config, "stale001") == "back to Machine Learning"
    assert client.get(f"/api/page/{TITLE}").status_code == 404


def test_stale_create_parks_even_when_the_page_was_recreated(
        client, seeded_config):
    seen = _delete_ml(client, seeded_config)
    fresh = _seq(seeded_config)
    r = _post(client, _create("fresh001", "new start"), seen_seq=fresh)
    assert r.status_code == 200
    assert client.get(f"/api/page/{TITLE}").status_code == 200
    r = _post(client, _create("stale001", "late"), seen_seq=seen)
    assert r.json()["skipped"][0]["reason"] == "page_deleted"
    assert _text(seeded_config, "stale001") is None
    [(header, children)] = _conflicts(client)
    assert header.startswith("[[conflict]] `Machine Learning`")
    assert children == ["late"]


def test_non_stale_batch_recreates_as_today(client, seeded_config):
    _delete_ml(client, seeded_config)
    r = _post(client, _create("fresh001", "new start"),
              seen_seq=_seq(seeded_config))
    assert r.status_code == 200
    assert r.json()["skipped"] == []
    assert client.get(f"/api/page/{TITLE}").status_code == 200


def test_batch_without_seen_seq_recreates_as_today(client, seeded_config):
    _delete_ml(client, seeded_config)
    r = _post(client, _create("fresh001", "new start"))
    assert r.status_code == 200
    assert r.json()["skipped"] == []
    assert client.get(f"/api/page/{TITLE}").status_code == 200


def test_seen_seq_beyond_latest_is_stale(client, seeded_config):
    _delete_ml(client, seeded_config)
    r = _post(client, _create("stale001", "from another database"),
              seen_seq=_seq(seeded_config) + 1000)
    assert r.json()["skipped"][0]["reason"] == "page_deleted"
    assert client.get(f"/api/page/{TITLE}").status_code == 404


def test_stale_update_text_leading_attribute_is_fenced_and_page_stays_deleted(
        client, seeded_config):
    seen = _delete_ml(client, seeded_config)
    r = _post(client,
              _create("stale001", "", parent="uid_b4", title="July 7th, 2026"),
              _update("stale001", f"{TITLE}:: v", ""),
              seen_seq=seen)
    assert r.status_code == 200
    assert _text(seeded_config, "stale001") == f"`{TITLE}`:: v"
    assert client.get(f"/api/page/{TITLE}").status_code == 404


def test_stale_create_with_linked_attribute_is_fenced_and_chains_clean(
        client, seeded_config):
    text = f"[[{TITLE}]]:: v"
    seen = _delete_ml(client, seeded_config)
    r = _post(client,
              _create("stale001", text, parent="uid_b4",
                      title="July 7th, 2026"),
              _update("stale001", text + " more", text),
              seen_seq=seen)
    assert r.status_code == 200
    assert r.json()["skipped"] == []
    assert _text(seeded_config, "stale001") == f"`{TITLE}`:: v more"
    assert client.get(f"/api/page/{TITLE}").status_code == 404
    assert _conflicts(client) == []


def test_stale_top_level_create_with_attribute_parks_the_fenced_text(
        client, seeded_config):
    seen = _delete_ml(client, seeded_config)
    r = _post(client, _create("stale001", f"{TITLE}:: v"), seen_seq=seen)
    assert r.status_code == 200
    [(_, children)] = _conflicts(client)
    assert children == [f"`{TITLE}`:: v"]
    assert client.get(f"/api/page/{TITLE}").status_code == 404
