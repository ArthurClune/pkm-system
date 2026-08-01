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
                                     PagePayload, QueryPayload, SearchPayload)

_REF_TOKEN = re.compile(r"\(\(([\w-]+)\)\)")

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


def select_section(blocks: Sequence[BlockNode],
                   spec: str) -> list[BlockNode]:
    """The subtree rooted at the first block whose text equals `spec`
    ('## Heading' or bare text). Raises RenderError naming the page's
    headings when nothing matches."""
    text = re.sub(r"^#{1,3} ", "", spec)
    for n in _walk(blocks):
        if n.text == text:
            return [n]
    headings = ", ".join(n.text for n in _walk(blocks) if n.heading)
    raise RenderError(f"no block titled {text!r} on the page"
                      f" (headings: {headings or 'none'})")


def clip_depth(blocks: Sequence[BlockNode], depth: int) -> list[BlockNode]:
    """Copy `blocks` keeping `depth` levels (1 = top level only)."""
    if depth <= 0:
        return []
    return [n.model_copy(update={"children": clip_depth(n.children, depth - 1)})
            for n in blocks]
