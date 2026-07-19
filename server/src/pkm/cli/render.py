# pattern: Functional Core
"""Render API payload dicts as terminal markdown. Pure text shaping; the
CLI/MCP shells decide what to fetch and whether to include uids."""
from __future__ import annotations


def _line(text: str, heading: int | None, depth: int, uid: str,
          include_uids: bool) -> str:
    body = f"{'#' * heading} {text}" if heading else text
    suffix = f"  ^{uid}" if include_uids else ""
    bullet = f"- {body}" if body else "-"
    return f"{'  ' * depth}{bullet}{suffix}"


def _bullets(nodes: list[dict], depth: int, include_uids: bool) -> list[str]:
    out: list[str] = []
    for n in nodes:
        out.append(_line(n["text"], n["heading"], depth, n["uid"],
                         include_uids))
        out.extend(_bullets(n["children"], depth + 1, include_uids))
    return out


def render_page(payload: dict, include_uids: bool = False) -> str:
    lines = [f"# {payload['page']['title']}", ""]
    lines.extend(_bullets(payload["blocks"], 0, include_uids))
    return "\n".join(lines) + "\n"


def render_block(payload: dict, include_uids: bool = False) -> str:
    crumbs = " > ".join([payload["page"]["title"], *payload["breadcrumbs"]])
    lines = [f"(in: {crumbs})", ""]
    lines.extend(_bullets([payload["block"]], 0, include_uids))
    return "\n".join(lines) + "\n"


def render_search(payload: dict) -> str:
    if not payload["pages"] and not payload["blocks"]:
        return "no results\n"
    lines = ["## Pages"]
    lines.extend(f"- {p['title']}" for p in payload["pages"])
    lines.append("")
    lines.append("## Blocks")
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
    return "\n".join(lines) + "\n"


def render_backlinks(title: str, backlinks: dict) -> str:
    lines = [f"# Backlinks: {title} ({backlinks['total_pages']} pages)"]
    for g in backlinks["groups"]:
        lines.append("")
        lines.append(f"## {g['page_title']}")
        lines.extend(f"- {i['text']}" for i in g["items"])
    return "\n".join(lines) + "\n"
