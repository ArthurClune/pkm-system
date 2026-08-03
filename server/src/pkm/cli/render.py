# pattern: Functional Core
"""Render API responses as terminal markdown. Pure text shaping over
`pkm.contracts.responses` models; the CLI/MCP shells decide what to fetch
and whether to include uids.

Takes the contract models rather than dicts (pkm-0wr8): a renderer
reading a field the server no longer sends is now a type error here, not
a KeyError in front of the user mid-command."""
from __future__ import annotations

import re
from collections.abc import Iterator, Mapping, Sequence

from pkm.contracts.responses import (AssetSearchPayload, Backlinks, BlockNode,
                                     BlockPayload, BlockRefText, GroupsPayload,
                                     PagePayload, QueryPayload, SearchPayload,
                                     TitleMigrationApplyResponse,
                                     TitleMigrationAuditPayload,
                                     TitleMigrationBlocker,
                                     TitleMigrationPage)

_REF_TOKEN = re.compile(r"\(\(([\w-]+)\)\)")
_SECTION_MARKER = re.compile(r"^(#{1,3}) (.*)$")

RefMap = Mapping[str, BlockRefText]


class RenderError(ValueError):
    pass


def _walk(nodes: Sequence[BlockNode]) -> Iterator[BlockNode]:
    for n in nodes:
        yield n
        yield from _walk(n.children)


def resolve_ref_texts(text: str, ref_map: RefMap,
                      _seen: frozenset = frozenset()) -> str:
    """Inline ((uid)) tokens from `ref_map` (a payload's block_ref_texts)
    as '"resolved text" ((uid))' — text visible, uid kept for follow-up.
    Recurses into resolved text; a uid already being expanded stays a bare
    token, so ref cycles terminate. Unknown uids are left untouched."""
    def _sub(m: re.Match) -> str:
        uid = m.group(1)
        if uid in _seen or uid not in ref_map:
            return m.group(0)
        inner = resolve_ref_texts(ref_map[uid].text, ref_map, _seen | {uid})
        return f'"{inner}" (({uid}))'
    return _REF_TOKEN.sub(_sub, text)


def _line(text: str, heading: int | None, depth: int, uid: str,
          include_uids: bool) -> str:
    body = f"{'#' * heading} {text}" if heading else text
    suffix = f"  ^{uid}" if include_uids else ""
    bullet = f"- {body}" if body else "-"
    return f"{'  ' * depth}{bullet}{suffix}"


def _bullets(nodes: Sequence[BlockNode], depth: int, include_uids: bool,
            ref_map: RefMap | None) -> list[str]:
    out: list[str] = []
    for n in nodes:
        text = resolve_ref_texts(n.text, ref_map) if ref_map is not None \
            else n.text
        out.append(_line(text, n.heading, depth, n.uid, include_uids))
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


def render_backlinks(title: str, backlinks: Backlinks) -> str:
    lines = [f"# Backlinks: {title} ({backlinks.total_pages} pages)"]
    for g in backlinks.groups:
        lines.append("")
        lines.append(f"## {g.page_title}")
        lines.extend(f"- {i.text}" for i in g.items)
    return "\n".join(lines) + "\n"


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


def _render_migration_page(
    page: TitleMigrationPage | TitleMigrationBlocker,
) -> str:
    return f'[{page.page_id}] "{page.title}"'


def _render_migration_blocker(blocker: TitleMigrationBlocker) -> str:
    return f'{_render_migration_page(blocker)} ({blocker.reason})'


def _title_migration_state(payload: TitleMigrationAuditPayload) -> str:
    if payload.active:
        return "active"
    if payload.blockers:
        return "blocked"
    if payload.groups:
        return "ready"
    return "clean"


def _count_label(n: int, singular: str, plural: str | None = None) -> str:
    plural = plural or f"{singular}s"
    label = singular if n == 1 else plural
    return f"{n} {label}"


def render_title_migration_audit(payload: TitleMigrationAuditPayload) -> str:
    lines = [
        "# Title migration audit",
        "",
        f"state: {_title_migration_state(payload)}",
        f"digest: {payload.digest}",
        f"groups: {len(payload.groups)}",
        f"blockers: {len(payload.blockers)}",
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
    if payload.blockers:
        lines.extend(["", "## Blockers"])
        lines.extend(f"- {_render_migration_blocker(blocker)}"
                     for blocker in payload.blockers)
    if not payload.groups and not payload.blockers:
        lines.extend([
            "",
            "No padded plain-space titles need migration.",
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
        f"generation: {payload.generation}",
    ]
    return "\n".join(lines) + "\n"


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
    for n in _walk(blocks):
        if n.text == text and (heading is None or n.heading == heading):
            return [n]
    headings = ", ".join(f"{'#' * n.heading} {n.text}"
                         for n in _walk(blocks) if n.heading)
    raise RenderError(f"no block titled {spec!r} on the page"
                      f" (headings: {headings or 'none'})")


def clip_depth(blocks: Sequence[BlockNode], depth: int) -> list[BlockNode]:
    """Copy `blocks` keeping `depth` levels (1 = top level only)."""
    if depth <= 0:
        return []
    return [n.model_copy(update={"children": clip_depth(n.children, depth - 1)})
            for n in blocks]
