"""A page delete's plan builds copies only for the page blocks a source
refers to, and stops once a source is known to pass the length cap. The
plan must be the one building every copy up front gave: the oracle below
is that eager planner, kept verbatim, and both run on random pages and
sources under a small cap so the limit paths are reached."""
from __future__ import annotations

from collections import Counter
from collections.abc import Mapping, Sequence

from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st

from pkm import text_limits, unlink
from pkm.contracts.ops import BlockUid
from pkm.refs import extract, normalize_title
from pkm.spans import splice, spliced_length
from pkm.test_data.ids import canonical_title_of, uid_of
from pkm.text_limits import rewrite_text_limit_violation
from pkm.spans import Span
from pkm.unlink import (DeleteBlocker, DeletePlan, SourceBlock, TitleMatch,
                        _rewrite_blocker_reason, _source_blocker_reason,
                        block_ref_spans, inline_block_refs, plain_copy,
                        plan_page_delete, unlink_title_refs)

SMALL_CAP = 80
PAGE_UIDS = [uid_of("pgblkAAA1"), uid_of("pgblkBBB2"), uid_of("pgblkCCC3")]


def _eager_copies(
    is_target: TitleMatch, page_blocks: Mapping[BlockUid, str]
) -> tuple[dict[BlockUid, str], frozenset[BlockUid]]:
    plain = {uid: plain_copy(text) for uid, text in page_blocks.items()}
    blanks = {uid: "" for uid in page_blocks}
    copies: dict[BlockUid, str] = {}
    oversized: set[BlockUid] = set()
    for uid in page_blocks:
        spans = block_ref_spans(plain[uid], plain)
        if spliced_length(plain[uid], spans) > unlink.MAX_BLOCK_TEXT_CHARS:
            oversized.add(uid)
            continue
        text = splice(plain[uid], spans)
        text = inline_block_refs(text, blanks)
        copies[uid] = unlink_title_refs(text, is_target)
    return copies, frozenset(oversized)


def _inlined_over_limit(text: str, spans: Sequence[Span]) -> bool:
    projected = spliced_length(text, spans)
    return (projected > unlink.MAX_BLOCK_TEXT_CHARS
            and projected > len(text))


def _eager_plan(
    is_target: TitleMatch,
    page_blocks: Mapping[BlockUid, str],
    sources: Sequence[SourceBlock],
) -> DeletePlan:
    copies, oversized = _eager_copies(is_target, page_blocks)
    rewrites: dict[BlockUid, str] = {}
    unlinked: set[BlockUid] = set()
    inlined: dict[BlockUid, Mapping[BlockUid, str]] = {}
    blockers: list[DeleteBlocker] = []
    link_pages: set[str] = set()
    ref_pages: set[str] = set()
    links = block_refs = 0
    for source in sources:
        parsed = extract(source.text)
        if any(is_target(ref.title) for ref in parsed.refs
               if ref.kind != "attribute"):
            links += 1
            link_pages.add(source.page_title)
        referenced = [u for u in parsed.block_refs if u in page_blocks]
        if referenced:
            block_refs += 1
            ref_pages.add(source.page_title)
        reason = _source_blocker_reason(is_target, source)
        applied: dict[BlockUid, str] = {}
        spans: list[Span] = []
        if reason is None:
            if any(u in oversized for u in referenced):
                reason = "limit"
            else:
                applied = {u: copies[u] for u in referenced}
                spans = block_ref_spans(source.text, applied)
                if _inlined_over_limit(source.text, spans):
                    reason = "limit"
        if reason is not None:
            blockers.append(
                DeleteBlocker(source.uid, source.page_title, source.text, reason)
            )
            continue
        pre = splice(source.text, spans)
        new = unlink_title_refs(pre, is_target)
        reason = _rewrite_blocker_reason(is_target, page_blocks, source, new)
        if reason is None and \
                rewrite_text_limit_violation(source.text, new) is not None:
            reason = "limit"
        if reason is not None:
            blockers.append(
                DeleteBlocker(source.uid, source.page_title, source.text, reason)
            )
            continue
        if new != source.text:
            rewrites[source.uid] = new
        if new != pre:
            unlinked.add(source.uid)
        if applied:
            inlined[source.uid] = applied
    return DeletePlan(
        rewrites=rewrites,
        unlinked=frozenset(unlinked),
        inlined=inlined,
        links=links,
        link_pages=len(link_pages),
        block_refs=block_refs,
        block_ref_pages=len(ref_pages),
        blockers=tuple(blockers),
    )


def _tokens(uids: list[BlockUid]) -> st.SearchStrategy[str]:
    ref = st.sampled_from(uids).map(lambda u: f"(({u}))")
    embed = st.sampled_from(uids).map(lambda u: f"{{{{embed: (({u}))}}}}")
    return st.one_of(
        ref, ref, embed,
        st.sampled_from([
            "[[T]]", "#T", "#[[T]]", "T:: v ", "[[T]]:: v ", " ", "\n", "`",
            "[a]([[T]])", "{{query: [[T]]}}", "[[x [[T]]]]", "TODO ", "y:: ",
            "((nopage123))", "[[Other]]"]),
        st.integers(1, 40).map(lambda n: "x" * n))


@st.composite
def graphs(draw):
    count = draw(st.integers(1, 3))
    uids = PAGE_UIDS[:count]
    text = st.lists(_tokens(uids), max_size=8).map("".join)
    page = {u: draw(text) for u in uids}
    sources = [SourceBlock(uid_of(f"srcblk{i:03d}"), canonical_title_of("Other"),
                           draw(st.lists(_tokens(uids), max_size=10).map("".join)))
               for i in range(draw(st.integers(1, 3)))]
    return page, sources


def is_t(raw: str) -> bool:
    return normalize_title(raw) == "T"


def test_the_lazy_plan_equals_the_eager_one(monkeypatch):
    seen = Counter()

    @settings(max_examples=2000, deadline=None,
              suppress_health_check=list(HealthCheck))
    @given(graphs())
    def prop(graph):
        page, sources = graph
        expected = _eager_plan(is_t, page, sources)
        assert plan_page_delete(is_t, page, sources) == expected
        seen["cases"] += 1
        reasons = {b.reason for b in expected.blockers}
        seen["limit"] += "limit" in reasons
        seen["inlined"] += bool(expected.inlined)
        seen["unblocked"] += len(expected.blockers) < len(sources)

    monkeypatch.setattr(unlink, "MAX_BLOCK_TEXT_CHARS", SMALL_CAP)
    monkeypatch.setattr(text_limits, "MAX_BLOCK_TEXT_CHARS", SMALL_CAP)
    prop()
    # About half the lowest rate seen over unseeded runs: a shape never
    # drawn would let the two planners differ there unseen.
    for shape, share in {"limit": 0.24, "inlined": 0.12, "unblocked": 0.3}.items():
        assert seen[shape] > seen["cases"] * share, (shape, seen[shape], seen["cases"])
