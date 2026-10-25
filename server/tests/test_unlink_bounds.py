"""The unlink a page delete, its preview and a stale or replayed edit run
under the write lock stays linear in the text it is given.

Two shapes once broke that within every limit. A title ending in `[`
re-forms a link to itself after each unlink (`[[a[]]` then `[a[]]`), so a
text one level deep took one pass per link. And a delete replay could
splice a stale edit into text nested to the cap around the deleted title,
which the unlink peels one layer per pass over the whole text. Titles
ending in `[` are refused now, the unlink stops after the passes its depth
needs, and the sites that splice copies in judge the depth times the
length first."""
from __future__ import annotations

from urllib.parse import quote

import httpx
import pytest
from hypothesis import given, settings
from hypothesis import strategies as st
from scaling import loop_steps
from test_text_limits_rewrites import _page_exists, _seed, _text

from pkm import refs, spans, text_limits, unlink
from pkm.contracts.ops import MAX_LINK_NESTING, BlockUid, SyncSeq, text_hash
from pkm.refs import extract, link_nesting_depth, normalize_title
from pkm.server import ops_core
from pkm.server.db import open_db
from pkm.server.ops_core import BlockRewrite, TextEditOutcome, classify_text_edit
from pkm.test_data.ids import (batch_id_of, canonical_title_of, client_id_of,
                               order_idx_of, seq_of, uid_of)
from pkm.unlink import (SourceBlock, plan_page_delete, unlink_stale_refs,
                        unlink_title_refs)

LEGACY = "a["
OTHER = canonical_title_of("Other")
SRC = uid_of("ub_src_001")
COPY_BLK = uid_of("ub_copy_01")
OPEN_BLK = uid_of("ub_open_01")
SHUT_BLK = uid_of("ub_shut_01")
MODULES = (unlink, refs, spans, ops_core, text_limits)
_batch_counter = 0


def nest(depth: int) -> str:
    """`depth` runs that are no refs."""
    return "[[a//" * depth + "x" + "]]" * depth


def is_legacy(raw: str) -> bool:
    return normalize_title(raw) == LEGACY


def is_t(raw: str) -> bool:
    return normalize_title(raw) == "T"


def chain(k: int) -> str:
    """One link to `a[`, then k spellings that each join the `a[` the
    unlink leaves into a fresh link. One level deep."""
    return "[[a[]]" + "[a[]]" * k


def _refs_to(text: str, is_target) -> list[str]:
    return [r.title for r in extract(text).refs if is_target(r.title)]


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


def _execute(config, *statements: tuple[str, tuple[object, ...]]) -> None:
    con = open_db(config.db_path)
    try:
        for sql, params in statements:
            con.execute(sql, params)
        con.commit()
    finally:
        con.close()


def _legacy_ref(config, src: BlockUid) -> None:
    """The refs row to `a[` a reindex wrote before that title was refused:
    a reindex now skips it, as it skips every refused title."""
    _execute(config, (
        "INSERT OR IGNORE INTO refs VALUES (?, (SELECT id FROM pages"
        " WHERE title = ?), 'link')", (src, LEGACY)))


def _forget(config, *uids: BlockUid) -> None:
    """Drop blocks a previous run seeded, with their index and rewrites."""
    for uid in uids:
        _execute(config,
                 ("DELETE FROM refs WHERE src_block_uid = ?", (uid,)),
                 ("DELETE FROM block_refs WHERE src_block_uid = ?", (uid,)),
                 ("DELETE FROM block_rewrites WHERE uid = ?", (uid,)),
                 ("DELETE FROM blocks WHERE uid = ?", (uid,)))


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


# -- a link that re-forms after each unlink (legacy titles) ---------------

def test_a_link_that_reforms_after_each_unlink_stops_at_the_pass_cap():
    # One pass per link at depth 1 made this quadratic: 40,006 characters
    # held the write lock 15 s. The passes stop at the depth plus two.
    def run(k: int) -> tuple[int, str]:
        out: list[str] = []
        work = loop_steps(MODULES, lambda: out.append(
            unlink_title_refs(chain(k), is_legacy)))
        return work, out[0]

    (small, _), (large, out) = run(500), run(2000)
    # four times the text: linear work grows about 4x
    assert large < 6 * small, (small, large)
    assert _refs_to(out, is_legacy)  # what the cap left


def test_a_delete_whose_unlink_does_not_settle_reports_the_source_residual():
    def run(k: int) -> tuple[int, list[str]]:
        plans: list[unlink.DeletePlan] = []
        work = loop_steps(MODULES, lambda: plans.append(plan_page_delete(
            is_legacy, {}, [SourceBlock(SRC, OTHER, chain(k))])))
        return work, [b.reason for b in plans[0].blockers]

    (small, _), (large, reasons) = run(500), run(2000)
    assert large < 6 * small, (small, large)
    assert reasons == ["residual"]


def test_a_stale_unlink_that_does_not_settle_fences_what_is_left():
    def run(k: int) -> tuple[int, str]:
        out: list[str] = []
        work = loop_steps(MODULES, lambda: out.append(
            unlink_stale_refs(chain(k), is_legacy)))
        return work, out[0]

    (small, _), (large, out) = run(500), run(2000)
    assert large < 6 * small, (small, large)
    assert _refs_to(out, is_legacy) == []
    # nothing the user wrote is lost: the fence only adds backticks
    assert out.replace("`", "").count("a") == chain(2000).count("a")


@pytest.mark.parametrize("text", [
    "x ` [[a[]]",       # a lone backtick before: the fence pairs with it
    "[[a[]] [[a[]] `",  # a lone backtick after
    "#[[a[]][a[]]",     # a tag
    "[l]([[a[]])[a[]]",  # an alias
    "[[a[]]\n[[a[]][a[]]",
])
def test_the_fence_leaves_no_link_to_the_page(text):
    # The fence alone, on text no unlink has touched.
    out = unlink._fence_title_refs(text, is_legacy)
    assert _refs_to(out, is_legacy) == []
    assert out.replace("`", "") == text.replace("`", "")


def test_a_legacy_delete_reports_the_residual_on_delete_and_preview(
        client, seeded_config):
    # A page titled `a[` stored before the rule, and a block linking it in
    # the shape that re-forms.
    def run(k: int) -> tuple[int, int, list[str], list[str]]:
        _forget(seeded_config, SRC)
        _seed(seeded_config, [(SRC, "Src", chain(k))], pages=(LEGACY,))
        _legacy_ref(seeded_config, SRC)
        got: dict[str, httpx.Response] = {}

        def go() -> None:
            got["preview"] = client.get("/api/delete-preview",
                                        params={"title": LEGACY})
            got["delete"] = client.delete(f"/api/page/{quote(LEGACY)}")
        work = loop_steps(MODULES, go)
        preview, delete = got["preview"], got["delete"]
        blocked = (delete.json()["detail"]["blockers"]
                   if delete.status_code == 409 else [])
        return (work, delete.status_code,
                [b["reason"] for b in preview.json()["blockers"]],
                [b["reason"] for b in blocked])

    (small, *_), (large, status, previewed, blocked) = run(500), run(2000)
    assert large < 6 * small, (small, large)
    assert status == 409
    assert previewed == blocked == ["residual"]
    assert _page_exists(seeded_config, LEGACY)
    assert _text(seeded_config, SRC) == chain(2000)


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


def test_a_replay_whose_splice_reforms_links_fences_what_is_left(
        client, seeded_config):
    # The delete of a legacy `a[` inlined a copy of `[a[]]` x k. A stale
    # edit sent before the delete ends in `[[a[`, holding no link, so it is
    # not refused; its replay splices the copy in after it and forms the
    # chain, which the unlink would peel one link per pass.
    def run(k: int) -> tuple[int, str]:
        _forget(seeded_config, SRC, COPY_BLK)
        original = f"[[a[]] (({COPY_BLK}))"
        _seed(seeded_config, [(COPY_BLK, LEGACY, "[a[]]" * k),
                              (SRC, "Src", original)])
        _legacy_ref(seeded_config, SRC)
        r = client.delete(f"/api/page/{quote(LEGACY)}")
        assert r.status_code == 200, r.text[:300]
        got = []
        work = loop_steps(MODULES, lambda: got.append(_post(client, {
            "op": "update_text", "uid": SRC,
            "text": f"[[a[(({COPY_BLK}))",
            "base_text_hash": text_hash(original)})))
        assert got[0].status_code == 200, got[0].text[:300]
        return work, str(_text(seeded_config, SRC))

    (small, _), (large, stored) = run(500), run(2000)
    assert large < 6 * small, (small, large)
    assert not _page_exists(seeded_config, LEGACY)
    assert _refs_to(stored, is_legacy) == []
    assert stored.replace("`", "").count("a") == 1 + 2000


# -- the cap never cuts an unlink short for an allowed title --------------

_TARGETS = ["T", "[x", "]x", "a ]b", "x y"]


def _settled(text: str, is_target) -> str:
    """The unlink without a cap: passes until nothing changes."""
    for _ in range(len(text) + 1):
        unlinked = unlink._unlink_pass(text, is_target)
        if unlinked == text:
            break
        text = unlinked
    return text


@settings(max_examples=3000, deadline=None)
@given(st.sampled_from(_TARGETS), st.data())
def test_the_pass_cap_never_stops_an_unlink_of_an_allowed_title(target, data):
    # Without code: a code span that moves as links go can show further
    # links, which the cap stops (fenced or `residual`).
    assert refs.title_syntax_reason(target) is None
    tokens = ["[[", "]]", "[", "]", "(", ")", "](", "#", "##", " ", "x",
              "T", "a", "\n", f"[[{target}]]", f"#[[{target}]]",
              f"[[ #{target} ]]", f"]]#{target}", f"[l]([[{target}]])",
              f"{target}::"]
    text = "".join(data.draw(st.lists(st.sampled_from(tokens), max_size=24)))

    def is_target(raw: str) -> bool:
        return normalize_title(raw) == target

    expected = _settled(text, is_target)
    assert unlink_title_refs(text, is_target) == expected
    assert unlink_stale_refs(text, is_target) == \
        unlink.defuse_attribute(expected, is_target)


@settings(max_examples=3000, deadline=None)
@given(st.data())
def test_a_stale_unlink_leaves_no_ref_to_a_legacy_title(data):
    tokens = ["[[", "]]", "[", "]", "(", ")", "](", "#", " ", "a", "a[",
              "[a[]]", "[[a[]]", "#[[a[]]", "[l]([[a[]])", "`", "\n",
              "a[::"]
    text = "".join(data.draw(st.lists(st.sampled_from(tokens), max_size=24)))
    out = unlink_stale_refs(text, is_legacy)
    assert _refs_to(out, is_legacy) == []


# -- the work the sites that splice copies in may ask for -----------------

def _wrapped(m: int, deep: bool) -> tuple[str, dict[BlockUid, str]]:
    """m links to T, each between a copy that opens 31 runs and one that
    closes them: spliced, each link sits 32 deep, at the nesting cap. The
    shallow twin has copies of the same length that open nothing."""
    unit = f"(({OPEN_BLK}))[[T]](({SHUT_BLK}))"
    depth = MAX_LINK_NESTING - 1
    copies: dict[BlockUid, str] = (
        {OPEN_BLK: "[[" * depth, SHUT_BLK: "]]" * depth} if deep
        else {OPEN_BLK: "((" * depth, SHUT_BLK: "))" * depth})
    return unit * m, copies


def _work_at(m: int, run) -> tuple[int, object, int, object]:
    """Loop steps and result for the deep shape and its shallow twin."""
    deep_work, deep = run(*_wrapped(m, True))
    shallow_work, shallow = run(*_wrapped(m, False))
    return deep_work, deep, shallow_work, shallow


def test_a_replay_judges_depth_times_length_before_unlinking():
    # A delete's two copies, each within the nesting cap; a stale edit
    # citing them around m links replays into text 32 deep, which the
    # unlink peels in 32 passes over the whole text: one 256 KB op held
    # the lock 41 s. Judged on the spliced text first, it lands as sent.
    def run(edit: str, copies: dict[BlockUid, str]):
        base, after = text_hash("orig"), text_hash("T")
        rows = (BlockRewrite(base, after, "T", "", "unlink"),
                *(BlockRewrite(base, after, uid, copy, "inline")
                  for uid, copy in copies.items()))
        out: list[TextEditOutcome] = []
        work = loop_steps(MODULES, lambda: out.append(
            classify_text_edit(edit, base, "T", rows)))
        return work, out[0].kind

    deep_work, deep, shallow_work, shallow = _work_at(1000, run)
    # the deep text costs no more than its shallow twin of the same length
    assert deep_work < 2 * shallow_work, (deep_work, shallow_work)
    assert deep == "over_limit"
    assert shallow == "clean"


def test_a_delete_judges_depth_times_length_before_unlinking():
    def run(source: str, copies: dict[BlockUid, str]):
        plans: list[unlink.DeletePlan] = []
        work = loop_steps(MODULES, lambda: plans.append(plan_page_delete(
            is_t, copies, [SourceBlock(SRC, OTHER, source)])))
        return work, [b.reason for b in plans[0].blockers]

    deep_work, deep, shallow_work, shallow = _work_at(1000, run)
    assert deep_work < 2 * shallow_work, (deep_work, shallow_work)
    assert deep == ["limit"]
    assert shallow == []


def test_a_page_block_copy_judges_depth_times_length_before_unlinking():
    # The same text inside a page block that a source cites once.
    def run(text: str, copies: dict[BlockUid, str]):
        page = {**copies, COPY_BLK: text}
        plans: list[unlink.DeletePlan] = []
        work = loop_steps(MODULES, lambda: plans.append(plan_page_delete(
            is_t, page, [SourceBlock(SRC, OTHER, f"(({COPY_BLK}))")])))
        return work, [b.reason for b in plans[0].blockers]

    deep_work, deep, shallow_work, shallow = _work_at(1000, run)
    assert deep_work < 2 * shallow_work, (deep_work, shallow_work)
    assert deep == ["limit"]
    assert shallow == []


def test_the_work_budget_is_judged_on_depth_times_length():
    budget = text_limits.MAX_UNLINK_WORK
    depth = 4
    link = "[[" * depth + "T" + "]]" * depth
    within = link + "x" * (budget // depth - len(link))
    assert link_nesting_depth(within) * len(within) == budget
    assert not text_limits.unlink_refused("", within)
    assert text_limits.unlink_refused("", within + "x")
    # no run, so nothing for the passes to peel, however long
    assert not text_limits.unlink_refused("", "x" * 2 * budget)


def test_each_rule_is_judged_against_the_text_before():
    deeper = nest(MAX_LINK_NESTING + 1)
    assert text_limits.unlink_refused("", deeper)
    # level: a legacy row already that deep may be unlinked
    assert not text_limits.unlink_refused(deeper, deeper)
    # and one already past the work budget, while its copies add nothing
    costly = nest(MAX_LINK_NESTING) + "x" * text_limits.MAX_UNLINK_WORK
    assert text_limits.unlink_refused("", costly)
    assert not text_limits.unlink_refused(costly, costly)
    assert not text_limits.unlink_refused(costly + "x", costly)
    assert text_limits.unlink_refused(costly, costly + "x")


@pytest.mark.parametrize("ops", [1, 4])
def test_a_stale_edit_replaying_a_delete_into_deep_text_lands_as_sent(
        client, seeded_config, ops):
    # The route: the delete inlined the two copies; the stale edit cites
    # them around 1,000 links, 129,000 characters 32 deep once spliced.
    # Every op lands as sent, skipped as `text_limit`, and T stays gone.
    def run(stale: str, copies: dict[BlockUid, str]):
        _forget(seeded_config, SRC)
        original = f"(({OPEN_BLK})) [[T]] (({SHUT_BLK}))"
        _seed(seeded_config, [*((uid, "T", copy)
                                for uid, copy in copies.items()),
                              (SRC, "Src", original)])
        assert client.delete("/api/page/T").status_code == 200
        op = {"op": "update_text", "uid": SRC, "text": stale,
              "base_text_hash": text_hash(original)}
        got = []
        work = loop_steps(MODULES, lambda: got.append(_post(client,
                                                            *[op] * ops)))
        assert got[0].status_code == 200, got[0].text[:300]
        return work, [s["reason"] for s in got[0].json()["skipped"]]

    deep_work, deep, shallow_work, shallow = _work_at(1000, run)
    assert deep_work < 2 * shallow_work, (deep_work, shallow_work)
    assert deep == ["text_limit"] * ops
    assert shallow == []
    assert not _page_exists(seeded_config, "T")
