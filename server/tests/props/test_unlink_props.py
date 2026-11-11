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

import re

import pytest
from hypothesis import given, settings, strategies as st

from hostile import count, event
from pkm.contracts.ops import BlockUid, text_hash
from pkm.refs import extract, normalize_title, strip_code
from pkm.server.ops_core import BlockRewrite, replay_title_rewrites
from pkm.unlink import (DeletePlan, SourceBlock, apply_delete_rewrite,
                        plan_page_delete, unlink_stale_refs)
from props.harness import examples, merge_floors
from pkm.test_data.ids import canonical_title_of, uid_of

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
        out = f"{draw(st.sampled_from(['Paper', 'Other Page', TARGET]))}:: {out}"
    return out


@st.composite
def stale_text(draw) -> str:
    """A block text that may lead with an attribute naming any title."""
    body = draw(st.sampled_from(["", ":", "::"])) + draw(block_text())
    shape = draw(st.sampled_from(["{}", "{}:: ", "[[{}]]:: ", "#{}:: ", "  {}:: "]))
    title = draw(st.sampled_from([*TITLES, BACKTICK_TITLE]))
    return shape.format(title) + body if shape != "{}" else body


@st.composite
def scenario(draw: st.DrawFn
             ) -> tuple[dict[BlockUid, str], list[SourceBlock]]:
    on_page = draw(st.integers(0, 4))
    page_blocks = {uid_of(uid): draw(block_text())
                   for uid in PAGE_UIDS[:on_page]}
    sources = [SourceBlock(uid_of(f"src_blk_0{n + 1}"),
                           canonical_title_of(draw(st.sampled_from(PAGES))),
                           draw(block_text()))
               for n in range(draw(st.integers(1, 5)))]
    return page_blocks, sources


def _titles(text: str, *, skip_attribute: bool) -> set[tuple[str, str]]:
    return {(r.title, r.kind) for r in extract(text).refs
            if not (skip_attribute and r.kind == "attribute")}


def _rows(original: str, new: str, uid: BlockUid, plan: DeletePlan
          ) -> list[BlockRewrite]:
    """The rows `Store._record_delete_rewrite` writes for one rewrite."""
    base, after = text_hash(original), text_hash(new)
    rows: list[BlockRewrite] = []
    if uid in plan.unlinked:
        rows.append(BlockRewrite(base, after, TARGET, "", "unlink"))
    rows.extend(BlockRewrite(base, after, target, copy, "inline")
                for target, copy in plan.inlined.get(uid, {}).items())
    return rows


_ALIAS_TO_TARGET = re.compile(r"\]\(\[\[AI\]\]\)")
_EMBED_OF_PAGE = re.compile(r"\{\{(?:embed|\[\[embed\]\]): \(\(pg_blk_")


def _delete_labels(page_blocks: dict[BlockUid, str], sources: list[SourceBlock],
                   plan: DeletePlan) -> set[str]:
    """The cases the delete's properties exist for that one scenario
    reached: each way a source refers to the page, each way a rewrite
    changes it, and each reason a source is kept as it is."""
    labels = {f"blocker: {b.reason}" for b in plan.blockers}
    for source in sources:
        parsed = extract(source.text)
        clean = strip_code(source.text)
        if any(r.title == TARGET and r.kind != "attribute"
               for r in parsed.refs):
            labels.add("source: links the page")
        if _ALIAS_TO_TARGET.search(clean):
            labels.add("source: links the page by alias")
        if any(u in page_blocks for u in parsed.block_refs):
            labels.add("source: refers to a page block")
        if _EMBED_OF_PAGE.search(clean):
            labels.add("source: embeds a page block")
    if plan.unlinked:
        labels.add("rewrite: unlinks")
    if plan.inlined:
        labels.add("rewrite: inlines a copy")
    if plan.unlinked & plan.inlined.keys():
        labels.add("rewrite: inlines and unlinks")
    if any(u in page_blocks for copies in plan.inlined.values()
           for copied in copies for u in extract(page_blocks[copied]).block_refs):
        labels.add("rewrite: inlines a copy that refers to a page block")
    return labels


def every_source_accounted_for(page_blocks: dict[BlockUid, str],
                               sources: list[SourceBlock],
                               plan: DeletePlan) -> None:
    blocked = {b.uid for b in plan.blockers}
    for source in sources:
        parsed = extract(source.text)
        in_scope = (
            any(r.title == TARGET and r.kind != "attribute"
                for r in parsed.refs)
            or any(u in page_blocks for u in parsed.block_refs))
        if in_scope:
            assert source.uid in plan.rewrites or source.uid in blocked, (
                f"silently skipped: {source.text!r}")
        if source.uid in blocked:
            assert source.uid not in plan.rewrites


def page_not_rederived(page_blocks: dict[BlockUid, str], original: str,
                       new: str) -> None:
    after = extract(new)
    assert not any(r.title == TARGET and r.kind != "attribute"
                   for r in after.refs), (original, new)
    assert not any(u in page_blocks for u in after.block_refs), (
        original, new)


def other_refs_survive(page_blocks: dict[BlockUid, str], original: str,
                       new: str) -> None:
    assert (_titles(original, skip_attribute=False)
            - {(TARGET, "link"), (TARGET, "tag")}
            # `[[embed]]` belongs to the embed macro that is replaced
            - {("embed", "link")}
            <= _titles(new, skip_attribute=False)), (original, new)
    kept = [u for u in extract(original).block_refs if u not in page_blocks]
    after = extract(new)
    assert all(u in after.block_refs for u in kept), (original, new)


def second_pass_inert(original: str, new: str) -> None:
    assert apply_delete_rewrite(new, is_target, {}) == new, (original, new)


def replay_reproduces(original: str, new: str, uid: BlockUid,
                      plan: DeletePlan) -> None:
    rows = _rows(original, new, uid, plan)
    assert rows, (original, new)
    assert replay_title_rewrites(
        original, text_hash(original), rows[::-1]
    ) == (new, text_hash(new)), (original, new)


def delete_rewrite_properties(
        case: tuple[dict[BlockUid, str], list[SourceBlock]]) -> None:
    count("example")
    page_blocks, sources = case
    plan = plan_page_delete(is_target, page_blocks, sources)
    for label in sorted(_delete_labels(page_blocks, sources, plan)):
        event(label)
    by_uid = {s.uid: s for s in sources}
    every_source_accounted_for(page_blocks, sources, plan)
    for uid, new in plan.rewrites.items():
        original = by_uid[uid].text
        page_not_rederived(page_blocks, original, new)
        other_refs_survive(page_blocks, original, new)
        second_pass_inert(original, new)
        replay_reproduces(original, new, uid, plan)


# Floors: half the lowest share over 30 unseeded merge runs, 2026-11-10.
@merge_floors({
    "blocker: used_as_attribute": 0.024,
    "rewrite: inlines a copy": 0.157,
    "rewrite: inlines a copy that refers to a page block": 0.084,
    "rewrite: inlines and unlinks": 0.063,
    "rewrite: unlinks": 0.198,
    "source: embeds a page block": 0.235,
    "source: links the page": 0.205,
    "source: links the page by alias": 0.058,
    "source: refers to a page block": 0.16,
}, "example")
@settings(max_examples=examples("unlink"))
@given(scenario())
def test_delete_rewrite_properties(case):
    delete_rewrite_properties(case)


# Floors: half the lowest share over 30 unseeded merge runs, 2026-11-10.
@merge_floors({
    "stale: attribute names the target": 0.033,
    "stale: links the target": 0.173,
    "stale: names a title holding a backtick": 0.03,
    "stale: nothing to strip": 0.239,
}, "example")
@settings(max_examples=examples("unlink"))
@given(stale_text())
def test_stale_unlink_leaves_no_ref_to_the_target(text):
    count("example")

    def target(raw: str) -> bool:
        return is_target(raw) or raw == BACKTICK_TITLE

    refs = extract(text).refs
    if any(target(r.title) and r.kind == "attribute" for r in refs):
        event("stale: attribute names the target")
    if any(target(r.title) and r.kind != "attribute" for r in refs):
        event("stale: links the target")
    if BACKTICK_TITLE in text:
        event("stale: names a title holding a backtick")
    result = unlink_stale_refs(text, target)
    if result == text:
        event("stale: nothing to strip")
    assert not any(target(ref.title) for ref in extract(result).refs), (
        f"{text!r} -> {result!r}")
