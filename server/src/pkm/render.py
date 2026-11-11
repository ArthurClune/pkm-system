# pattern: Functional Core
"""Render API responses as terminal markdown. Pure text shaping over
`pkm.contracts.responses` models; the CLI/MCP shells decide what to fetch
and whether to include uids. Transport-neutral on purpose: `pkm` and
`pkm-mcp` both render through here, so this module imports neither.

Takes the contract models rather than dicts: a renderer
reading a field the server no longer sends is now a type error here, not
a KeyError in front of the user mid-command."""
from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from datetime import datetime, tzinfo

from pkm.contracts.ops import BlockUid
from pkm.contracts.titles import RawTitle
from pkm.contracts.responses import (AssetSearchPayload, Backlinks, BlockNode,
                                     BlockPayload, BlockRefText, ChangedPayload,
                                     GoodlinksCheckPayload, GroupsPayload,
                                     LocalCheckPayload, OpsAck, PagePayload,
                                     QueryPayload, RenamePageResponse,
                                     SkipReason,
                                     SearchPayload, TitleMigrationApplyResponse,
                                     TitleMigrationAuditPayload,
                                     TitleMigrationBlocker,
                                     TitleMigrationPage, walk_blocks)
from pkm.refs import BLOCK_REF_TOKEN, parse_block_uid

_REF_TOKEN = re.compile(rf"\(\(({BLOCK_REF_TOKEN})\)\)")
_SECTION_MARKER = re.compile(r"(#{1,3}) (.*)")

RefMap = Mapping[BlockUid, BlockRefText]


class RenderError(ValueError):
    pass


def resolve_ref_texts(text: str, ref_map: RefMap,
                      _seen: frozenset[str] = frozenset()) -> str:
    """Inline ((uid)) tokens from `ref_map` (a payload's block_ref_texts)
    as '"resolved text" ((uid))' — text visible, uid kept for follow-up.
    Recurses into resolved text; a uid already being expanded stays a bare
    token, so ref cycles terminate. Unknown uids are left untouched."""
    def _sub(m: re.Match[str]) -> str:
        # The regex matches BLOCK_REF_TOKEN's shape, so the capture parses;
        # whether it names a live block is what the ref_map lookup below
        # actually decides.
        uid = parse_block_uid(m.group(1))
        if uid is None or uid in _seen or uid not in ref_map:
            return m.group(0)
        inner = resolve_ref_texts(ref_map[uid].text, ref_map, _seen | {uid})
        return f'"{inner}" (({uid}))'
    return _REF_TOKEN.sub(_sub, text)


def _line(text: str, heading: int | None, depth: int, uid: BlockUid,
          include_uids: bool) -> str:
    body = f"{'#' * heading} {text}" if heading else text
    suffix = f"  ^{uid}" if include_uids else ""
    bullet = f"- {body}" if body else "-"
    return f"{'  ' * depth}{bullet}{suffix}"


def _resolved(n: BlockNode, ref_map: RefMap | None) -> str:
    return resolve_ref_texts(n.text, ref_map) if ref_map is not None \
        else n.text


def _bullets(nodes: Sequence[BlockNode], depth: int, include_uids: bool,
            ref_map: RefMap | None) -> list[str]:
    out: list[str] = []
    for n in nodes:
        out.append(_line(_resolved(n, ref_map), n.heading, depth, n.uid,
                         include_uids))
        out.extend(_bullets(n.children, depth + 1, include_uids, ref_map))
    return out


def render_page(payload: PagePayload, include_uids: bool = False,
                resolve_refs: bool = False) -> str:
    ref_map = payload.block_ref_texts if resolve_refs else None
    lines = [f"# {payload.page.title}", ""]
    lines.extend(_bullets(payload.blocks, 0, include_uids, ref_map))
    return "\n".join(lines) + "\n"


def render_block(payload: BlockPayload, include_uids: bool = False,
                 resolve_refs: bool = False) -> str:
    ref_map = payload.block_ref_texts if resolve_refs else None
    crumbs = " > ".join([payload.page.title, *payload.breadcrumbs])
    lines = [f"(in: {crumbs})", ""]
    lines.extend(_bullets([payload.block], 0, include_uids, ref_map))
    return "\n".join(lines) + "\n"


OUTLINE_TEXT_CHARS = 200
_CLIPPED = " \u2026[clipped]"


def _subtree_chars(n: BlockNode, depth: int, ref_map: RefMap | None) -> int:
    """Characters `_bullets` emits for `n` and its descendants, newlines
    included, so root sizes sum to the body of the full render."""
    own = len(_line(_resolved(n, ref_map), n.heading, depth, n.uid, True)) + 1
    return own + sum(_subtree_chars(c, depth + 1, ref_map)
                     for c in n.children)


def _tree_depth(nodes: Sequence[BlockNode]) -> int:
    return 1 + max((_tree_depth(n.children) for n in nodes), default=0) \
        if nodes else 0


def _clip_first_line(text: str) -> tuple[str, bool]:
    """`text`'s first line cut to OUTLINE_TEXT_CHARS, with the clipped
    marker when anything was dropped, and whether anything was."""
    first = text.split("\n", 1)[0]
    clipped = len(first) > OUTLINE_TEXT_CHARS or first != text
    return first[:OUTLINE_TEXT_CHARS] + (_CLIPPED if clipped else ""), clipped


def _outline_lines(nodes: Sequence[BlockNode], depth: int, levels: int,
                   ref_map: RefMap | None) -> list[str]:
    out: list[str] = []
    for n in nodes:
        text = _resolved(n, ref_map)
        shown, clipped = _clip_first_line(text)
        cut = clipped or (bool(n.children) and depth + 1 >= levels)
        size = f"  ({_subtree_chars(n, depth, ref_map):,} chars)" if cut \
            else ""
        mark = f"{'#' * n.heading} " if n.heading else ""
        out.append(f"{'  ' * depth}- {mark}{shown}  ^{n.uid}{size}")
        if depth + 1 < levels:
            out.extend(_outline_lines(n.children, depth + 1, levels,
                                      ref_map))
    return out


def _outline(head: str, noun: str, what: str, lead: Sequence[str],
             roots: Sequence[BlockNode], depth: int, ref_map: RefMap | None,
             full_len: int, max_chars: int) -> str:
    """The deepest outline of `roots`, starting at `depth` after the `lead`
    lines, that fits `max_chars` under `head`."""
    for levels in range(depth + _tree_depth(roots), depth, -1):
        unit = "level" if levels == 1 else "levels"
        note = (f"(Outline only: the full {noun} is {full_len:,} characters,"
                f" over this tool's {max_chars:,}-character limit. Shown"
                f' {levels} {unit} deep; "(N chars)" marks a block not shown'
                " in full. Fetch one with get_block(uid).)")
        body = "\n".join([*lead, *_outline_lines(roots, depth, levels,
                                                  ref_map)])
        out = f"{head}\n\n{note}\n\n{body}\n"
        if len(out) <= max_chars:
            return out
    raise RenderError(
        f"{what} is {full_len:,} characters and even its top-level outline"
        f" is over the {max_chars:,}-character limit; use search instead")


def render_page_bounded(payload: PagePayload, max_chars: int,
                        resolve_refs: bool = False) -> str:
    """The full uid-annotated render when it fits `max_chars`, else the
    deepest outline that does. Raises RenderError when not even the
    top-level outline fits."""
    full = render_page(payload, include_uids=True, resolve_refs=resolve_refs)
    if len(full) <= max_chars:
        return full
    ref_map = payload.block_ref_texts if resolve_refs else None
    return _outline(f"# {payload.page.title}", "page", "the page", [],
                    payload.blocks, 0, ref_map, len(full), max_chars)


def render_block_bounded(payload: BlockPayload, max_chars: int,
                         resolve_refs: bool = False) -> str:
    """`render_page_bounded` for one block's subtree. The block's own text
    is always shown whole, since no other tool returns it; only its
    children are outlined. Raises RenderError when that text alone is over
    `max_chars`."""
    full = render_block(payload, include_uids=True,
                        resolve_refs=resolve_refs)
    if len(full) <= max_chars:
        return full
    block = payload.block
    ref_map = payload.block_ref_texts if resolve_refs else None
    crumbs = " > ".join([payload.page.title, *payload.breadcrumbs])
    head = f"(in: {crumbs})"
    own = _line(_resolved(block, ref_map), block.heading, 0, block.uid, True)
    if len(f"{head}\n\n{own}\n") > max_chars:
        raise RenderError(
            f"block {block.uid} alone is {len(own):,} characters, over the"
            f" {max_chars:,}-character limit, and cannot be split; use"
            " search to find the passage")
    return _outline(head, "block", f"block {block.uid}", [own],
                    block.children, 1, ref_map, len(full), max_chars)


def render_search(payload: SearchPayload, compact: bool = False) -> str:
    if not payload.pages and not payload.blocks:
        return "no results\n"
    lines = ["## Pages"]
    lines.extend(f"- {p.title}" for p in payload.pages)
    lines.append("")
    lines.append("## Blocks")
    if compact:
        lines.extend(f"- [{b.page_title}] ^{b.uid}" for b in payload.blocks)
    else:
        lines.extend(f"- [{b.page_title}] {b.snippet}" for b in payload.blocks)
    return "\n".join(lines) + "\n"


def render_groups(payload: GroupsPayload, include_uids: bool = True) -> str:
    lines: list[str] = []
    for g in payload.groups:
        lines.append(f"## {g.page_title}")
        for item in g.items:
            suffix = f"  ^{item.uid}" if include_uids else ""
            lines.append(f"- {item.text}{suffix}")
        lines.append("")
    lines.append(f"({payload.total} total)")
    # Only /api/query carries per-operand counts, and they are the steer
    # for an empty result -- noise once there are hits.
    if isinstance(payload, QueryPayload) and payload.ref_counts \
            and payload.total == 0:
        pairs = ", ".join(f"[[{t}]] {n}" for t, n in payload.ref_counts.items())
        lines.append(f"per-ref block counts: {pairs}")
    return "\n".join(lines) + "\n"


def _bounded_list(head: Sequence[str],
                  groups: Sequence[tuple[str, Sequence[tuple[str, str, BlockUid]]]],
                  total: int, pages_total: int, full_len: int, max_chars: int,
                  hint: str, pages_floor: bool = False) -> str:
    """The longest prefix of `groups` (title, [(prefix, text, uid)]) that
    fits `max_chars` after `head` and a partial-list note, whole items in
    order. The note's counts describe what is shown, so each candidate is
    measured with the note it would carry. `pages_floor` marks
    `pages_total` as a lower bound (the route cut its own list)."""
    plus = "+" if pages_floor else ""
    def build(shown: int, body: list[list[str]]) -> str:
        note = (f"(Partial list: showing {shown} of {total} blocks from"
                f" {len(body)} of {pages_total}{plus} pages; the full result is"
                f" {full_len:,} characters, over this tool's"
                f" {max_chars:,}-character limit. {hint}"
                " A \u2026[clipped] line's full text is get_block(uid).)")
        parts = [*head, *([""] if head else []), note]
        for lines in body:
            parts += ["", *lines]
        return "\n".join(parts) + "\n"

    def refuse() -> RenderError:
        return RenderError(
            f"the result is {full_len:,} characters and not even its first"
            f" block fits the {max_chars:,}-character limit. {hint}")

    body: list[list[str]] = []
    shown = 0
    for title, items in groups:
        for i, (prefix, text, uid) in enumerate(items):
            line = f"- {prefix}{_clip_first_line(text)[0]}  ^{uid}"
            trial = [*body, [f"## {title}", line]] if i == 0 \
                else [*body[:-1], [*body[-1], line]]
            if len(build(shown + 1, trial)) > max_chars:
                if not shown:
                    raise refuse()
                return build(shown, body)
            body, shown = trial, shown + 1
    if not shown:
        raise refuse()
    return build(shown, body)


def render_groups_bounded(payload: GroupsPayload, max_chars: int,
                          hint: str) -> str:
    """`render_groups` with uids when it fits `max_chars`, else the leading
    whole blocks, each clipped to its first line, under a partial-list
    note ending in `hint`. Raises RenderError when not even the first
    block fits."""
    full = render_groups(payload)
    if len(full) <= max_chars:
        return full
    groups = [(g.page_title, [("", i.text, i.uid) for i in g.items])
              for g in payload.groups]
    return _bounded_list([], groups, payload.total, len(groups), len(full),
                         max_chars, hint)


def _local(ms: int, tz: tzinfo) -> datetime:
    return datetime.fromtimestamp(ms / 1000, tz=tz)


def render_changed(payload: ChangedPayload, tz: tzinfo) -> str:
    """Like render_groups, but each line carries the block's local
    updated_at (HH:MM, or 'YYYY-MM-DD HH:MM' when the window spans more
    than one local day) and its new/edited status. `tz` is the caller's
    local timezone -- passed in rather than read here, so this stays a
    pure function of its arguments."""
    multi_day = (_local(payload.since, tz).date()
                != _local(max(payload.until - 1, payload.since), tz).date())
    fmt = "%Y-%m-%d %H:%M" if multi_day else "%H:%M"
    lines: list[str] = []
    shown = 0
    for g in payload.groups:
        lines.append(f"## {g.page_title}")
        for item in g.items:
            when = _local(item.updated_at, tz).strftime(fmt) \
                if item.updated_at is not None else "?"
            lines.append(f"- [{when}] {item.status}: {item.text}"
                        f"  ^{item.uid}")
            shown += 1
        lines.append("")
    if shown < payload.total:
        lines.append(f"(showing {shown} of {payload.total} total)")
    else:
        lines.append(f"({payload.total} total)")
    return "\n".join(lines) + "\n"


def render_changed_bounded(payload: ChangedPayload, tz: tzinfo,
                           max_chars: int, hint: str) -> str:
    """`render_groups_bounded` for `render_changed`; lines keep their
    time and status prefix, and the note counts against `payload.total`."""
    full = render_changed(payload, tz)
    if len(full) <= max_chars:
        return full
    multi_day = (_local(payload.since, tz).date()
                != _local(max(payload.until - 1, payload.since), tz).date())
    fmt = "%Y-%m-%d %H:%M" if multi_day else "%H:%M"
    groups = [(g.page_title,
               [(f"[{_local(i.updated_at, tz).strftime(fmt) if i.updated_at is not None else '?'}]"
                 f" {i.status}: ", i.text, i.uid) for i in g.items])
              for g in payload.groups]
    returned = sum(len(g.items) for g in payload.groups)
    return _bounded_list([], groups, payload.total, len(groups), len(full),
                         max_chars, hint, payload.total > returned)


def render_backlinks(title: RawTitle, backlinks: Backlinks) -> str:
    lines = [f"# Backlinks: {title} ({backlinks.total_pages} pages)"]
    for g in backlinks.groups:
        lines.append("")
        lines.append(f"## {g.page_title}")
        lines.extend(f"- {i.text}" for i in g.items)
    return "\n".join(lines) + "\n"


def render_backlinks_bounded(title: RawTitle, backlinks: Backlinks,
                             max_chars: int) -> str:
    """`render_backlinks` when it fits `max_chars`, else the leading whole
    blocks with uids under the unchanged header and a partial-list note."""
    full = render_backlinks(title, backlinks)
    if len(full) <= max_chars:
        return full
    groups = [(g.page_title, [("", i.text, i.uid) for i in g.items])
              for g in backlinks.groups]
    total = sum(len(items) for _, items in groups)
    hint = f"Narrow it with query, e.g. {{and: [[{title}]] [[Other]]}}."
    return _bounded_list(
        [f"# Backlinks: {title} ({backlinks.total_pages} pages)"], groups,
        total, backlinks.total_pages, len(full), max_chars, hint)


def render_assets(payload: AssetSearchPayload) -> str:
    """One asset per block: filename, url, status, description, then one
    'in [[page]] ((uid))' line per referencing block."""
    if not payload.assets:
        return "no assets found"
    parts = []
    for a in payload.assets:
        lines = [f"{a.filename}  ({a.mime}, {a.size} bytes, {a.status})",
                 f"  {a.url}"]
        if a.description:
            lines.append(f"  {a.description}")
        for ref in a.refs:
            lines.append(f"  in [[{ref.page_title}]] (({ref.uid}))")
        parts.append("\n".join(lines))
    return "\n\n".join(parts)


def render_local_check(payload: LocalCheckPayload) -> str:
    """One summary line, then `page | status | href` per problem."""
    lines = [f"{payload.total} local link(s), {payload.ok} ok,"
             f" {len(payload.problems)} problem(s)"]
    lines += [f"{p.page} | {p.status} | {p.href}" for p in payload.problems]
    return "\n".join(lines)


def render_goodlinks_check(payload: GoodlinksCheckPayload) -> str:
    """One summary line, then `page | status | href` per problem."""
    lines = [f"{payload.total} goodlinks link(s), {payload.ok} ok,"
             f" {len(payload.problems)} problem(s)"]
    lines += [f"{p.page} | {p.status} | {p.href}" for p in payload.problems]
    return "\n".join(lines)


def _render_migration_page(
    page: TitleMigrationPage | TitleMigrationBlocker,
) -> str:
    return f'[{page.page_id}] "{page.title}"'


def _render_migration_blocker(blocker: TitleMigrationBlocker) -> str:
    return f'{_render_migration_page(blocker)} ({blocker.reason})'


def _title_migration_state(payload: TitleMigrationAuditPayload) -> str:
    """An active database can still hold work: titles that a later change
    to the fold rule left non-canonical."""
    if payload.blockers:
        state = "blocked"
    elif payload.groups or payload.sidebar_retitles:
        state = "ready"
    else:
        return "active" if payload.active else "clean"
    return f"active, {state}" if payload.active else state


def _count_label(n: int, singular: str, plural: str | None = None) -> str:
    plural = plural or f"{singular}s"
    label = singular if n == 1 else plural
    return f"{n} {label}"


_SKIP_REASON_TEXT: dict[SkipReason, str] = {
    "block_not_found": "block not found",
    "parent_not_found": "parent block not found",
    "cycle": "target is the block itself or one of its descendants",
    "page_deleted": "the page was deleted before this device synced",
    "text_limit": ("replayed over a rename or page delete it missed, the"
                   " edit would be over a text limit"),
}


def render_ops_ack(ack: OpsAck) -> str:
    """A batch's result for `pkm batch` / MCP `batch`. The server skips an
    op whose block (or parent) no longer exists, or a move that would make
    a cycle, instead of failing the batch, so for a caller that sends uids
    unchecked the `skipped` list is the only sign one was mistyped; it
    leads with a warning."""
    if not ack.skipped:
        return f"applied {ack.applied} ops"
    done = ack.applied - len(ack.skipped)
    rest = ("nothing else was applied" if done == 0 else
            f"the other {done} {'was' if done == 1 else 'were'} applied")
    lines = [f"warning: skipped {len(ack.skipped)} of {ack.applied} ops;"
             f" {rest}"]
    for s in ack.skipped:
        what = _SKIP_REASON_TEXT[s.reason]
        where = (f"noted on [[{s.note_page}]]" if s.note_page is not None
                 else "nothing written")
        lines.append(f"  {s.op} ^{s.uid}: {what}; {where}")
    # the batch committed: a re-run is a new batch_id and repeats every
    # op that did apply, creates included
    lines.append("the batch is committed: fix the skipped ops on their own,"
                 " do not re-run it")
    return "\n".join(lines)


def render_title_migration_audit(payload: TitleMigrationAuditPayload) -> str:
    lines = [
        "# Title migration audit",
        "",
        f"state: {_title_migration_state(payload)}",
        f"digest: {payload.digest}",
        f"groups: {len(payload.groups)}",
        f"blockers: {len(payload.blockers)}",
        f"sidebar retitles: {len(payload.sidebar_retitles)}",
    ]
    if payload.groups:
        for group in payload.groups:
            lines.extend([
                "",
                f"## {group.canonical_title}",
                f"survivor: {_render_migration_page(group.survivor)}",
                "sources:",
            ])
            lines.extend(f"- {_render_migration_page(page)}"
                         for page in group.sources)
            lines.extend([
                f"has clean twin: {'yes' if group.has_clean_twin else 'no'}",
                "counts: "
                f"{_count_label(group.block_count, 'block')}, "
                f"{_count_label(group.inbound_ref_count, 'inbound ref')}, "
                f"{_count_label(group.sidebar_count, 'sidebar entry', 'sidebar entries')}",
                "merge order:",
            ])
            lines.extend(
                f"- {_render_migration_page(page)}"
                f" -> {_render_migration_page(group.survivor)}"
                for page in group.sources
            )
    if payload.sidebar_retitles:
        lines.extend(["", "## Sidebar entries"])
        lines.extend(
            f'- [{retitle.sidebar_id}] "{retitle.title}"'
            f' -> "{retitle.canonical_title}"'
            for retitle in payload.sidebar_retitles
        )
    if payload.blockers:
        lines.extend(["", "## Blockers"])
        lines.extend(f"- {_render_migration_blocker(blocker)}"
                     for blocker in payload.blockers)
    if (not payload.groups and not payload.blockers
            and not payload.sidebar_retitles):
        lines.extend([
            "",
            "Nothing to merge or retitle.",
            "Migration is already active; apply mode is unavailable."
            if payload.active else
            "Apply mode is disabled until you provide an audit digest explicitly.",
        ])
    return "\n".join(lines) + "\n"


def render_title_migration_apply(payload: TitleMigrationApplyResponse) -> str:
    lines = [
        "# Title migration applied",
        "",
        f"digest: {payload.digest}",
        f"groups applied: {payload.groups_applied}",
        f"pages retitled: {payload.pages_retitled}",
        f"pages merged: {payload.pages_merged}",
        f"blocks moved: {payload.blocks_moved}",
        f"blocks rewritten: {payload.blocks_rewritten}",
        f"sidebar entries retitled: {payload.sidebars_retitled}",
        f"generation: {payload.generation}",
    ]
    return "\n".join(lines) + "\n"


def render_rename(old_title: RawTitle, result: RenamePageResponse) -> str:
    if result.result == "merged":
        return f'merged "{old_title}" into "{result.title}"'
    return f'renamed "{old_title}" -> "{result.title}"'


def select_section(blocks: Sequence[BlockNode],
                   spec: str) -> list[BlockNode]:
    """The subtree rooted at the first block matching `spec`. A marked
    spec ('## Heading') matches that exact heading level and text; bare
    text matches regardless of heading level. Ties (duplicate text, or a
    bare spec matching several levels) resolve to the first match in
    document order. Raises RenderError listing the page's marked
    headings (with their level markers) when nothing matches."""
    marked = _SECTION_MARKER.fullmatch(spec)
    heading = len(marked.group(1)) if marked else None
    text = marked.group(2) if marked else spec
    for n in walk_blocks(blocks):
        if n.text == text and (heading is None or n.heading == heading):
            return [n]
    headings = ", ".join(f"{'#' * n.heading} {n.text}"
                         for n in walk_blocks(blocks) if n.heading)
    raise RenderError(f"no block titled {spec!r} on the page"
                      f" (headings: {headings or 'none'})")


def clip_depth(blocks: Sequence[BlockNode], depth: int) -> list[BlockNode]:
    """Copy `blocks` keeping `depth` levels (1 = top level only)."""
    if depth <= 0:
        return []
    return [
        BlockNode(uid=n.uid, text=n.text, heading=n.heading,
                  view_type=n.view_type, collapsed=n.collapsed,
                  order_idx=n.order_idx, created_at=n.created_at,
                  updated_at=n.updated_at,
                  children=clip_depth(n.children, depth - 1))
        for n in blocks]
