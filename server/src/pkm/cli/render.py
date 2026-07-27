# pattern: Functional Core
"""Render API payload dicts as terminal markdown. Pure text shaping; the
CLI/MCP shells decide what to fetch and whether to include uids."""
from __future__ import annotations

import re

_REF_TOKEN = re.compile(r"\(\(([\w-]+)\)\)")


class RenderError(ValueError):
    pass


def _walk(nodes: list[dict]):
    for n in nodes:
        yield n
        yield from _walk(n["children"])


def resolve_ref_texts(text: str, ref_map: dict,
                      _seen: frozenset = frozenset()) -> str:
    """Inline ((uid)) tokens from `ref_map` (a payload's block_ref_texts)
    as '"resolved text" ((uid))' — text visible, uid kept for follow-up.
    Recurses into resolved text; a uid already being expanded stays a bare
    token, so ref cycles terminate. Unknown uids are left untouched."""
    def _sub(m: re.Match) -> str:
        uid = m.group(1)
        if uid in _seen or uid not in ref_map:
            return m.group(0)
        inner = resolve_ref_texts(ref_map[uid]["text"], ref_map,
                                  _seen | {uid})
        return f'"{inner}" (({uid}))'
    return _REF_TOKEN.sub(_sub, text)


def _line(text: str, heading: int | None, depth: int, uid: str,
          include_uids: bool) -> str:
    body = f"{'#' * heading} {text}" if heading else text
    suffix = f"  ^{uid}" if include_uids else ""
    bullet = f"- {body}" if body else "-"
    return f"{'  ' * depth}{bullet}{suffix}"


def _bullets(nodes: list[dict], depth: int, include_uids: bool,
            ref_map: dict | None) -> list[str]:
    out: list[str] = []
    for n in nodes:
        text = resolve_ref_texts(n["text"], ref_map) if ref_map is not None \
            else n["text"]
        out.append(_line(text, n["heading"], depth, n["uid"], include_uids))
        out.extend(_bullets(n["children"], depth + 1, include_uids, ref_map))
    return out


def render_page(payload: dict, include_uids: bool = False,
                resolve_refs: bool = False) -> str:
    ref_map = payload["block_ref_texts"] if resolve_refs else None
    lines = [f"# {payload['page']['title']}", ""]
    lines.extend(_bullets(payload["blocks"], 0, include_uids, ref_map))
    return "\n".join(lines) + "\n"


def render_block(payload: dict, include_uids: bool = False,
                 resolve_refs: bool = False) -> str:
    ref_map = payload["block_ref_texts"] if resolve_refs else None
    crumbs = " > ".join([payload["page"]["title"], *payload["breadcrumbs"]])
    lines = [f"(in: {crumbs})", ""]
    lines.extend(_bullets([payload["block"]], 0, include_uids, ref_map))
    return "\n".join(lines) + "\n"


def render_search(payload: dict, compact: bool = False) -> str:
    if not payload["pages"] and not payload["blocks"]:
        return "no results\n"
    lines = ["## Pages"]
    lines.extend(f"- {p['title']}" for p in payload["pages"])
    lines.append("")
    lines.append("## Blocks")
    if compact:
        lines.extend(f"- [{b['page_title']}] ^{b['uid']}"
                     for b in payload["blocks"])
    else:
        lines.extend(f"- [{b['page_title']}] {b['snippet']}"
                     for b in payload["blocks"])
    return "\n".join(lines) + "\n"


def render_groups(payload: dict, include_uids: bool = True) -> str:
    lines: list[str] = []
    for g in payload["groups"]:
        lines.append(f"## {g['page_title']}")
        for item in g["items"]:
            suffix = f"  ^{item['uid']}" if include_uids else ""
            lines.append(f"- {item['text']}{suffix}")
        lines.append("")
    lines.append(f"({payload['total']} total)")
    counts = payload.get("ref_counts")
    if counts and payload["total"] == 0:
        pairs = ", ".join(f"[[{t}]] {n}" for t, n in counts.items())
        lines.append(f"per-ref block counts: {pairs}")
    return "\n".join(lines) + "\n"


def render_backlinks(title: str, backlinks: dict) -> str:
    lines = [f"# Backlinks: {title} ({backlinks['total_pages']} pages)"]
    for g in backlinks["groups"]:
        lines.append("")
        lines.append(f"## {g['page_title']}")
        lines.extend(f"- {i['text']}" for i in g["items"])
    return "\n".join(lines) + "\n"


def render_assets(payload: dict) -> str:
    """One asset per block: filename, url, status, then the description."""
    assets = payload["assets"]
    if not assets:
        return "no assets found"
    parts = []
    for a in assets:
        lines = [f"{a['filename']}  ({a['mime']}, {a['size']} bytes,"
                 f" {a['status']})",
                 f"  {a['url']}"]
        if a["description"]:
            lines.append(f"  {a['description']}")
        parts.append("\n".join(lines))
    return "\n\n".join(parts)


def select_section(blocks: list[dict], spec: str) -> list[dict]:
    """The subtree rooted at the first block whose text equals `spec`
    ('## Heading' or bare text). Raises RenderError naming the page's
    headings when nothing matches."""
    text = re.sub(r"^#{1,3} ", "", spec)
    for n in _walk(blocks):
        if n["text"] == text:
            return [n]
    headings = ", ".join(n["text"] for n in _walk(blocks) if n["heading"])
    raise RenderError(f"no block titled {text!r} on the page"
                      f" (headings: {headings or 'none'})")


def clip_depth(blocks: list[dict], depth: int) -> list[dict]:
    """Copy `blocks` keeping `depth` levels (1 = top level only)."""
    if depth <= 0:
        return []
    return [{**n, "children": clip_depth(n["children"], depth - 1)}
            for n in blocks]
