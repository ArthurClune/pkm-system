"""A page delete's plan builds copies only for the page blocks a source
refers to, and stops once a source is known to pass the length cap. The
oracle below is the planner that built every copy up front, kept as it
was, with one switch. Off, a source's inlined length counts each copy at
its final length, and nothing else is judged (the rule before copies were
built lazily). On, each copy counts at its projected length before deeper
refs are blanked, and the copy text counted over all referring blocks may
not pass the delete's budget, and a copy or a source with its copies in
may not nest past the cap, deeper than it was, before it is unlinked (the
rules now, which bound the work a copy that blanks to "" costs, the work
over many referrers, and the unlink's passes, which grow with the depth).
The plan must equal the eager planner with the switch on, and differ from
it with the switch off only by refusing more sources as `limit`. Both run
on random pages and sources under a small cap, budget and nesting cap so
the limit paths are reached."""
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
from pkm.text_limits import (rewrite_nesting_violation,
                              rewrite_text_limit_violation)
from pkm.spans import Span
from pkm.unlink import (DeleteBlocker, DeletePlan, SourceBlock, TitleMatch,
                        _rewrite_blocker_reason, _source_blocker_reason,
                        block_ref_spans, inline_block_refs, plain_copy,
                        plan_page_delete, unlink_title_refs)

SMALL_CAP = 80
SMALL_BUDGET = 60
SMALL_NESTING = 1
# sources the eager planner refused for the budget alone, for the reach
# count below; those it refused for the nesting before unlinking; and of
# those, the ones refused for a page block's own copy
BUDGET_REFUSALS: list[BlockUid] = []
NESTING_REFUSALS: list[BlockUid] = []
COPY_NESTING_REFUSALS: list[BlockUid] = []
PAGE_UIDS = [uid_of("pgblkAAA1"), uid_of("pgblkBBB2"), uid_of("pgblkCCC3")]


def _eager_copies(
    is_target: TitleMatch, page_blocks: Mapping[BlockUid, str]
) -> tuple[dict[BlockUid, str], frozenset[BlockUid], dict[BlockUid, int],
           frozenset[BlockUid]]:
    """The copies, the uids over the length cap (never built), each copy's
    projected length, and the uids whose spliced copy nests past the cap
    deeper than the block (built and unlinked here all the same)."""
    plain = {uid: plain_copy(text) for uid, text in page_blocks.items()}
    blanks = {uid: "" for uid in page_blocks}
    copies: dict[BlockUid, str] = {}
    oversized: set[BlockUid] = set()
    deep: set[BlockUid] = set()
    projected: dict[BlockUid, int] = {}
    for uid in page_blocks:
        spans = block_ref_spans(plain[uid], plain)
        projected[uid] = spliced_length(plain[uid], spans)
        if projected[uid] > unlink.MAX_BLOCK_TEXT_CHARS:
            oversized.add(uid)
            continue
        text = splice(plain[uid], spans)
        text = inline_block_refs(text, blanks)
        if rewrite_nesting_violation(plain[uid], text) is not None:
            deep.add(uid)
        copies[uid] = unlink_title_refs(text, is_target)
    return copies, frozenset(oversized), projected, frozenset(deep)


def _inlined_over_limit(text: str, spans: Sequence[Span]) -> bool:
    projected = spliced_length(text, spans)
    return (projected > unlink.MAX_BLOCK_TEXT_CHARS
            and projected > len(text))


def _eager_plan(
    is_target: TitleMatch,
    page_blocks: Mapping[BlockUid, str],
    sources: Sequence[SourceBlock],
    count_projected: bool,
) -> DeletePlan:
    copies, oversized, projected, deep = _eager_copies(is_target,
                                                       page_blocks)
    counted = 0
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
                # stand-ins as long as each copy before it was blanked
                judged = block_ref_spans(source.text, {
                    u: " " * projected[u] for u in referenced}) \
                    if count_projected else spans
                if _inlined_over_limit(source.text, judged):
                    reason = "limit"
                elif count_projected:
                    added = spliced_length(source.text, judged) - \
                        spliced_length(source.text, block_ref_spans(
                            source.text, {u: "" for u in referenced}))
                    if counted + added > unlink.MAX_DELETE_COPY_CHARS:
                        reason = "limit"
                        BUDGET_REFUSALS.append(source.uid)
                    else:
                        counted += added
        if reason is not None:
            blockers.append(
                DeleteBlocker(source.uid, source.page_title, source.text, reason)
            )
            continue
        pre = splice(source.text, spans)
        if count_projected and (
                any(u in deep for u in referenced)
                or rewrite_nesting_violation(source.text, pre) is not None):
            NESTING_REFUSALS.append(source.uid)
            if any(u in deep for u in referenced):
                COPY_NESTING_REFUSALS.append(source.uid)
            blockers.append(
                DeleteBlocker(source.uid, source.page_title, source.text,
                              "limit"))
            continue
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


# Page blocks of bare brackets, and texts of refs to them: copies that
# open runs another copy closes, which nest once inlined.
_BRACKETS = st.lists(st.sampled_from(["[[", "]]"]), min_size=1,
                     max_size=3).map("".join)


def _bracket_refs(uids: list[BlockUid]) -> st.SearchStrategy[str]:
    ref = st.sampled_from(uids).map(lambda u: f"(({u}))")
    return st.lists(st.one_of(ref, ref, st.sampled_from(["[[T]]", "x"])),
                    min_size=2, max_size=5).map("".join)


@st.composite
def graphs(draw):
    mode = draw(st.integers(0, 7))
    joins_in_copy = mode < 2
    count = 3 if joins_in_copy else draw(st.integers(1, 3))
    uids = PAGE_UIDS[:count]
    if joins_in_copy:
        # the third block's own copy joins the first two
        page = {uids[0]: "[[" * draw(st.integers(1, 3)),
                uids[1]: "]]" * draw(st.integers(1, 3)),
                uids[2]: draw(_bracket_refs(uids[:2]))}
        source_text = _bracket_refs(uids[2:])
    else:
        if mode < 4:
            page_text, source_text = _BRACKETS, _bracket_refs(uids)
        else:
            page_text = st.lists(_tokens(uids), max_size=8).map("".join)
            source_text = st.lists(_tokens(uids), max_size=10).map("".join)
        page = {u: draw(page_text) for u in uids}
    sources = [SourceBlock(uid_of(f"srcblk{i:03d}"), canonical_title_of("Other"),
                           draw(source_text))
               for i in range(draw(st.integers(1, 5)))]
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
        BUDGET_REFUSALS.clear()
        NESTING_REFUSALS.clear()
        COPY_NESTING_REFUSALS.clear()
        expected = _eager_plan(is_t, page, sources, count_projected=True)
        seen["budget"] += bool(BUDGET_REFUSALS)
        seen["nesting"] += bool(NESTING_REFUSALS)
        seen["copy_nesting"] += bool(COPY_NESTING_REFUSALS)
        plan = plan_page_delete(is_t, page, sources)
        assert plan == expected
        # against the rule before: only more `limit` refusals
        before = _eager_plan(is_t, page, sources, count_projected=False)
        assert (plan.links, plan.link_pages, plan.block_refs,
                plan.block_ref_pages) == (
            before.links, before.link_pages, before.block_refs,
            before.block_ref_pages)
        now = {b.uid: b.reason for b in plan.blockers}
        was = {b.uid: b.reason for b in before.blockers}
        for source in sources:
            if source.uid not in now:
                assert source.uid not in was
                assert plan.rewrites.get(source.uid) == \
                    before.rewrites.get(source.uid)
            elif now[source.uid] != was.get(source.uid):
                assert now[source.uid] == "limit"
                seen["stricter"] += 1
        seen["cases"] += 1
        reasons = {b.reason for b in expected.blockers}
        seen["limit"] += "limit" in reasons
        seen["inlined"] += bool(expected.inlined)
        seen["unblocked"] += len(expected.blockers) < len(sources)

    monkeypatch.setattr(unlink, "MAX_BLOCK_TEXT_CHARS", SMALL_CAP)
    monkeypatch.setattr(text_limits, "MAX_BLOCK_TEXT_CHARS", SMALL_CAP)
    monkeypatch.setattr(unlink, "MAX_DELETE_COPY_CHARS", SMALL_BUDGET)
    monkeypatch.setattr(text_limits, "MAX_LINK_NESTING", SMALL_NESTING)
    prop()
    # About half the lowest rate seen over unseeded runs: a shape never
    # drawn would let the two planners differ there unseen.
    for shape, share in {"limit": 0.24, "inlined": 0.11, "unblocked": 0.3,
                         "stricter": 0.02, "budget": 0.025, "nesting": 0.02,
                         "copy_nesting": 0.006}.items():
        assert seen[shape] > seen["cases"] * share, (shape, seen[shape], seen["cases"])
