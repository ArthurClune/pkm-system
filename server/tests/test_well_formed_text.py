"""Block text is well-formed Unicode on the write path: a lone surrogate in
anything the ops contract carries becomes U+FFFD at the boundary, never a
500 and never a rejection, and the shared hashes agree with the web's
TextEncoder for any str.

A browser's JSON.stringify sends a lone surrogate as a `\\udXXX` escape,
which Python's json turns back into a lone-surrogate str. The bodies here
are built the same way, with json.dumps' default ASCII escapes, because
httpx's own json= encoding refuses a lone surrogate before it is sent."""
import hashlib
import json
from datetime import date

from hypothesis import currently_in_test_context, given, settings
from hypothesis import event as _event
from hypothesis import strategies as st

from pkm.client.workflows import apply_batch
from pkm.contracts.daily import title_for_date
from pkm.contracts.ops import BlockUid, OpBatch, subtree_hash, text_hash
from pkm.contracts.text import well_formed
from pkm.test_data.ids import batch_id_of, uid_of

LONE_HIGH = "\ud800"
LONE_LOW = "\udc00"


def event(label: str) -> None:
    if currently_in_test_context():
        _event(label)


_counter = 0


def _post_escaped(client, *ops, raw_batch: str | None = None,
                  raw_client: str = "c1"):
    global _counter
    if raw_batch is None:
        _counter += 1
        raw_batch = batch_id_of(f"wf_batch_{_counter:08d}")
    body = json.dumps({"client_id": raw_client, "batch_id": raw_batch,
                       "ops": list(ops)})
    assert "\\ud800" in body or "\\udc00" in body
    return client.post("/api/ops", content=body,
                       headers={"content-type": "application/json"})


def _daily_texts(client) -> list[str]:
    r = client.get(f"/api/page/{title_for_date(date.today())}")
    return [] if r.status_code == 404 else \
        [b["text"] for b in r.json()["blocks"]]


def _block_text(client, uid: BlockUid) -> str:
    r = client.get(f"/api/block/{uid}")
    assert r.status_code == 200
    return r.json()["block"]["text"]


def test_update_text_with_a_lone_surrogate_is_stored_as_replacement(client):
    r = _post_escaped(client, {"op": "update_text", "uid": "uid_b4",
                               "text": f"a{LONE_HIGH}b"})
    assert r.status_code == 200, r.text
    assert r.json()["ok"] is True
    assert _block_text(client, uid_of("uid_b4")) == "a\ufffdb"


def test_an_edit_based_on_the_browser_hash_of_the_raw_text_applies(client):
    """The browser hashes its own copy through TextEncoder, which already
    reads the lone surrogate as U+FFFD, so its base_text_hash for the next
    edit matches what the server stored: no spurious conflict."""
    _post_escaped(client, {"op": "update_text", "uid": "uid_b4",
                           "text": f"x{LONE_LOW}y"})
    browser_hash = hashlib.sha256("x\ufffdy".encode()).hexdigest()
    assert text_hash(f"x{LONE_LOW}y") == browser_hash
    r = client.post("/api/ops", json={
        "client_id": "c1", "batch_id": batch_id_of("wf_followup_1"),
        "ops": [{"op": "update_text", "uid": "uid_b4", "text": "after",
                 "base_text_hash": browser_hash}]})
    assert r.status_code == 200
    assert _block_text(client, uid_of("uid_b4")) == "after"
    assert not any("[[conflict]]" in t for t in _daily_texts(client))


def test_create_with_lone_surrogates_in_text_and_title(client):
    r = _post_escaped(client, {
        "op": "create", "uid": "wfnew01", "page_title": f"P{LONE_HIGH}",
        "parent_uid": None, "order_idx": 0, "text": f"{LONE_LOW}t"})
    assert r.status_code == 200, r.text
    assert _block_text(client, uid_of("wfnew01")) == "\ufffdt"
    page = client.get("/api/page/P\ufffd").json()
    assert page["page"]["title"] == "P\ufffd"


def test_create_page_and_move_titles_normalise(client):
    r = _post_escaped(
        client,
        {"op": "create_page", "page_title": f"Q{LONE_LOW}"},
        {"op": "move", "uid": "uid_b4", "parent_uid": None,
         "order_idx": 0, "page_title": f"Q{LONE_LOW}"},
        {"op": "update_text", "uid": "uid_b3", "text": "t",
         "page_title": f"label{LONE_HIGH}"})
    assert r.status_code == 200, r.text
    page = client.get("/api/page/Q\ufffd").json()
    assert [b["uid"] for b in page["blocks"]] == ["uid_b4"]


def test_lone_surrogate_ids_never_500(client):
    """An odd batch or client id is only an id, and a uid no client could
    have minted is the 400 any such uid gets: neither reaches SQLite, or
    the JSON encoder, as a lone surrogate."""
    r = _post_escaped(client, {"op": "set_collapsed", "uid": "uid_b2",
                               "collapsed": True},
                      raw_batch=f"batch{LONE_LOW}0001",
                      raw_client=f"c{LONE_HIGH}")
    assert r.status_code == 200, r.text
    r = _post_escaped(client, {"op": "update_text",
                               "uid": f"uid{LONE_HIGH}x", "text": "t"})
    assert r.status_code == 400
    assert r.json()["detail"]["reason"] == "block not found: uid\ufffdx"


def test_normalised_batch_replays_as_the_same_batch(client):
    op = {"op": "update_text", "uid": "uid_b4", "text": f"r{LONE_HIGH}"}
    batch_id = batch_id_of("wf_replay_01")
    first = _post_escaped(client, op, raw_batch=batch_id)
    again = _post_escaped(client, op, raw_batch=batch_id)
    assert first.status_code == again.status_code == 200
    assert again.json()["applied"] == first.json()["applied"]
    plain = client.post("/api/ops", json={
        "client_id": "c1", "batch_id": batch_id,
        "ops": [{"op": "update_text", "uid": "uid_b4", "text": "r\ufffd"}]})
    assert plain.status_code == 200


def test_cli_and_mcp_client_normalise_before_sending(pkm_client, client):
    """PkmClient validates through OpBatch before httpx encodes the body,
    so a lone surrogate (an argv byte Python decoded with surrogateescape,
    say) reaches the wire as U+FFFD instead of failing to encode."""
    pkm_client.post_ops([{"op": "update_text", "uid": "uid_b4",
                          "text": "argv\udcff"}],
                        batch_id=batch_id_of("wf_client_1"))
    assert _block_text(client, uid_of("uid_b4")) == "argv\ufffd"


def test_mcp_and_cli_batch_commands_normalise_before_any_fetch(pkm_client,
                                                               client):
    """The batch tool fetches every page it names before planning; a title
    holding a lone surrogate would fail to percent-encode in the client."""
    apply_batch(pkm_client, [{"command": "create", "params": {
        "page": f"Batch{LONE_HIGH}", "text": f"t{LONE_LOW}"}}])
    page = client.get("/api/page/Batch\ufffd").json()
    assert [b["text"] for b in page["blocks"]] == ["t\ufffd"]


def test_nul_crlf_and_astral_text_round_trips_unchanged(client):
    text = "a\x00b\r\nc \U0001f468\u200d\U0001f469 e\u0301"
    r = client.post("/api/ops", json={
        "client_id": "c1", "batch_id": batch_id_of("wf_nul_0001"),
        "ops": [{"op": "update_text", "uid": "uid_b4", "text": text}]})
    assert r.status_code == 200
    assert _block_text(client, uid_of("uid_b4")) == text


def test_well_formed_cases():
    assert well_formed("plain") == "plain"
    assert well_formed(f"a{LONE_HIGH}b") == "a\ufffdb"
    assert well_formed(f"{LONE_LOW}{LONE_HIGH}") == "\ufffd\ufffd"
    assert well_formed(f"{LONE_HIGH}{LONE_HIGH}") == "\ufffd\ufffd"
    assert well_formed("\ud83d\ude00") == "\U0001f600"
    assert well_formed("\x00\r\n") == "\x00\r\n"


def test_op_batch_normalises_every_string_field():
    # Decoded the way the route's body is: json.loads of the escaped text.
    wire = json.dumps({
        "client_id": f"c{LONE_HIGH}", "batch_id": f"b{LONE_LOW}0000000",
        "ops": [{"op": "create", "uid": f"u{LONE_HIGH}00000",
                 "page_title": f"t{LONE_LOW}", "parent_uid": f"p{LONE_LOW}",
                 "order_idx": 0, "text": f"x{LONE_HIGH}"}]})
    batch = OpBatch.model_validate(json.loads(wire))
    dumped = json.dumps(batch.model_dump(), ensure_ascii=False)
    dumped.encode()
    assert "\ufffd" in dumped


# Pieces a hostile text is built from. st.characters() leaves out category
# Cs (surrogates) unless asked, so they are drawn explicitly here.
_PIECES = st.one_of(
    st.characters(min_codepoint=0xD800, max_codepoint=0xDBFF),
    st.characters(min_codepoint=0xDC00, max_codepoint=0xDFFF),
    st.sampled_from(["\U0001f600", "\U0001f468\u200d\U0001f469\u200d\U0001f467",
                     "e\u0301", "\x00", "\r\n", "a", " "]),
    st.text(max_size=3),
)


def _shapes(text: str) -> set[str]:
    units = text.encode("utf-16-le", "surrogatepass")
    codes = [int.from_bytes(units[i:i + 2], "little")
             for i in range(0, len(units), 2)]
    found = set()
    for i, c in enumerate(codes):
        prev = codes[i - 1] if i > 0 else None
        nxt = codes[i + 1] if i + 1 < len(codes) else None
        if 0xD800 <= c <= 0xDBFF and not (nxt and 0xDC00 <= nxt <= 0xDFFF):
            found.add("lone high")
        if 0xDC00 <= c <= 0xDFFF and not (prev and 0xD800 <= prev <= 0xDBFF):
            found.add("lone low")
        if 0xDC00 <= c <= 0xDFFF and prev and 0xD800 <= prev <= 0xDBFF:
            found.add("pair")
    return found


@settings(max_examples=400)
@given(st.lists(_PIECES, max_size=8).map("".join))
def test_well_formed_is_total_and_idempotent(text):
    for shape in sorted(_shapes(text)):
        event(f"shape: {shape}")
    has_surrogate = any(0xD800 <= ord(c) <= 0xDFFF for c in text)
    fixed = well_formed(text)
    fixed.encode()
    assert well_formed(fixed) == fixed
    if not has_surrogate:
        assert fixed is text
    else:
        assert "\ufffd" in fixed or len(fixed) < len(text)
    assert text_hash(text) == text_hash(fixed)
    assert subtree_hash([("u1", text)]) == subtree_hash([("u1", fixed)])
