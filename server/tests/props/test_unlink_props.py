"""Property tests of the page-delete rewriter (`pkm.unlink`), pure and with
no database: deleting the page "AI" turns every inbound reference into plain
text and copies the page's blocks in place of `((refs))` to them.

Block texts are random mixes of links, tags, aliased links, block refs,
embeds, code spans and a leading `Name::` attribute, over a small title and
uid pool so that copies chain and cycle. The properties are the delete's
anti-goals: the page is never re-derived, no source is silently skipped,
other references survive, a second pass is inert, and the replay a stale
offline edit gets reproduces the rewrite."""
from __future__ import annotations

import pytest
from hypothesis import given, settings, strategies as st

from pkm.contracts.ops import text_hash
from pkm.refs import extract, normalize_title
from pkm.server.ops_core import BlockRewrite, replay_title_rewrites
from pkm.unlink import (DeletePlan, SourceBlock, apply_delete_rewrite,
                        plan_page_delete, unlink_stale_refs)
from props.harness import examples

pytestmark = pytest.mark.proptest

TARGET = "AI"
TITLES = ["AI", "ai", "Paper", "Other Page", "AI Ethics"]
BARE_TITLES = [t for t in TITLES if " " not in t]
BACKTICK_TITLE = "a`b"
PAGE_UIDS = [f"pg_blk_0{n}" for n in range(1, 5)]
OTHER_UIDS = ["ot_blk_01", "ot_blk_02"]
PAGES = ["Notes", "Log", "Journal"]


def is_target(raw: str) -> bool:
    return normalize_title(raw) == TARGET


_title = st.sampled_from(TITLES)
_uid = st.sampled_from(PAGE_UIDS + OTHER_UIDS)
_word = st.sampled_from(["word", "text", "todo", "x", "a-b"])


@st.composite
def _fragment(draw, allow_code: bool = True) -> str:
    kind = draw(st.sampled_from(
        ["word", "link", "tag", "btag", "alias", "ref", "embed", "embed2"]
        + (["code"] if allow_code else [])))
    if kind == "word":
        return draw(_word)
    if kind == "link":
        return f"[[{draw(_title)}]]"
    if kind == "tag":
        return f"#{draw(st.sampled_from(BARE_TITLES))}"
    if kind == "btag":
        return f"#[[{draw(_title)}]]"
    if kind == "alias":
        label = draw(st.one_of(
            _word, st.builds("#{}".format, st.sampled_from(BARE_TITLES))))
        return f"[{label}]([[{draw(_title)}]])"
    if kind == "ref":
        return f"(({draw(_uid)}))"
    if kind == "embed":
        return f"{{{{embed: (({draw(_uid)}))}}}}"
    if kind == "embed2":
        return f"{{{{[[embed]]: (({draw(_uid)}))}}}}"
    return "`" + draw(_fragment(allow_code=False)) + "`"


@st.composite
def block_text(draw) -> str:
    frags = draw(st.lists(_fragment(), max_size=8))
    out = ""
    for frag in frags:
        out += (draw(st.sampled_from([" ", "\n"])) if out else "") + frag
    if draw(st.booleans()) and draw(st.integers(0, 3)) == 0:
        out = f"{draw(st.sampled_from(['Paper', 'Other Page']))}:: {out}"
    return out


@st.composite
def stale_text(draw) -> str:
    """A block text that may lead with an attribute naming any title."""
    body = draw(st.sampled_from(["", ":", "::"])) + draw(block_text())
    shape = draw(st.sampled_from(["{}", "{}:: ", "[[{}]]:: ", "#{}:: ", "  {}:: "]))
    title = draw(st.sampled_from([*TITLES, BACKTICK_TITLE]))
    return shape.format(title) + body if shape != "{}" else body


@st.composite
def scenario(draw) -> tuple[dict[str, str], list[SourceBlock]]:
    count = draw(st.integers(0, 4))
    page_blocks = {uid: draw(block_text()) for uid in PAGE_UIDS[:count]}
    sources = [SourceBlock(f"src_blk_0{n + 1}", draw(st.sampled_from(PAGES)),
                           draw(block_text()))
               for n in range(draw(st.integers(1, 5)))]
    return page_blocks, sources


def _titles(text: str, *, skip_attribute: bool) -> set[tuple[str, str]]:
    return {(r.title, r.kind) for r in extract(text).refs
            if not (skip_attribute and r.kind == "attribute")}


def _rows(original: str, new: str, uid: str, plan: DeletePlan
          ) -> list[BlockRewrite]:
    """The rows `Store._record_delete_rewrite` writes for one rewrite."""
    base, after = text_hash(original), text_hash(new)
    rows: list[BlockRewrite] = []
    if uid in plan.unlinked:
        rows.append(BlockRewrite(base, after, TARGET, "", "unlink"))
    rows.extend(BlockRewrite(base, after, target, copy, "inline")
                for target, copy in plan.inlined.get(uid, {}).items())
    return rows


@settings(max_examples=examples("unlink"))
@given(scenario())
def test_delete_rewrite_properties(case):
    page_blocks, sources = case
    plan = plan_page_delete(is_target, page_blocks, sources)
    by_uid = {s.uid: s for s in sources}
    blocked = {b.uid for b in plan.blockers}

    for source in sources:
        parsed = extract(source.text)
        in_scope = (
            any(r.title == TARGET and r.kind != "attribute"
                for r in parsed.refs)
            or any(u in page_blocks for u in parsed.block_refs))
        # P2 every source is accounted for
        if in_scope:
            assert source.uid in plan.rewrites or source.uid in blocked, (
                f"silently skipped: {source.text!r}")
        if source.uid in blocked:
            assert source.uid not in plan.rewrites

    for uid, new in plan.rewrites.items():
        original = by_uid[uid].text
        after = extract(new)
        # P1 nothing re-derives the page
        assert not any(r.title == TARGET and r.kind != "attribute"
                       for r in after.refs), (original, new)
        assert not any(u in page_blocks for u in after.block_refs), (
            original, new)
        # P3 other references survive
        assert (_titles(original, skip_attribute=False)
                - {(TARGET, "link"), (TARGET, "tag")}
                # `[[embed]]` belongs to the embed macro that is replaced
                - {("embed", "link")}
                <= _titles(new, skip_attribute=False)), (original, new)
        kept = [u for u in extract(original).block_refs
                if u not in page_blocks]
        assert all(u in after.block_refs for u in kept), (original, new)
        # P4 idempotent
        assert apply_delete_rewrite(new, is_target, {}) == new, (original, new)
        # P5 replay reproduces the rewrite
        rows = _rows(original, new, uid, plan)
        assert rows, (original, new)
        assert replay_title_rewrites(
            original, text_hash(original), rows[::-1]
        ) == (new, text_hash(new)), (original, new)


@settings(max_examples=examples("unlink"))
@given(stale_text())
def test_stale_unlink_leaves_no_ref_to_the_target(text):
    def target(raw: str) -> bool:
        return is_target(raw) or raw == BACKTICK_TITLE

    result = unlink_stale_refs(text, target)
    assert not any(target(ref.title) for ref in extract(result).refs), (
        f"{text!r} -> {result!r}")
