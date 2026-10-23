"""Hostile names shared by the export guard tests: page titles and asset
filenames that must never turn into a path outside an archive or a header
that is anything but printable ASCII, and helpers to seed and check them."""
import hashlib
import unicodedata
from pathlib import Path

from pkm.server.db import open_db

HEADER_TITLES = [
    'a"b', "a\\b", "x\r\nSet-Cookie: evil=1", "x\nX-Injected: 1",
    'semi; filename="evil.exe"', "evil\u202egpj.md", "café ünïcode 日本",
    "..", "../../etc/passwd", "/abs", "C:\\win", "a\x00b", "a\x7fb",
    "\u2028line", "%0d%0a", "x" * 400, "日" * 200, "CON", "nul.txt",
    'a<b>c|d?e*f"g', "  .  ", "\ufeffbom", "\U0010ffff",
]

ROUTE_TITLES = ['semi; filename="evil.exe"', 'quote"back\\slash',
                "evil\u202egpj", "x\r\nSet-Cookie: e=1"]

ZIP_TITLES = [
    "..", "../../evil", "/abs/path", "C:\\drive", "\\\\server\\share",
    "a\x00b", "CON", "x" * 600, "café", unicodedata.normalize("NFD", "café"),
    "Σίσυφος", "σίσυφος", "ς", "σ", "Straße", "STRASSE", "ǅ", "ǆ", "ﬀ", "ff",
    "K", "\u212a", ".hidden", "...", "a\U000e0001",
]

ASSET_NAMES = [
    "../../../../tmp/zipslip.txt", "/etc/passwd", "C:\\evil.txt",
    "..\\..\\evil.txt", "a\x00b.png", ".", "..", "CON", "con.png",
    "Straße.txt", "STRASSE.txt", "100%_done.txt", 'q"uote.txt',
]


def add_pages(db_path: Path, titles: list[str], first_id: int = 100) -> None:
    con = open_db(db_path)
    for i, title in enumerate(titles):
        page_id = first_id + i
        con.execute("INSERT INTO pages VALUES (?,?,?,?)",
                    (page_id, title, None, None))
        con.execute(
            "INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text,"
            " heading, collapsed, created_at, updated_at)"
            " VALUES (?,?,?,?,?,?,?,?,?)",
            (f"uid_z{i:03d}", page_id, None, 0, f"BODY-{i}", None, 0, None,
             None))
    con.commit()
    con.close()


def add_asset_rows(db_path: Path, assets_dir: Path,
                   names: list[str]) -> list[str]:
    """Store one asset per name, file and row, and return the digests."""
    con = open_db(db_path)
    shas = []
    for i, name in enumerate(names):
        data = f"asset-{i}".encode()
        sha = hashlib.sha256(data).hexdigest()
        shas.append(sha)
        (assets_dir / sha[:2]).mkdir(exist_ok=True)
        (assets_dir / sha[:2] / sha).write_bytes(data)
        con.execute(
            "INSERT INTO assets(sha256, filename, mime, size, created_at)"
            " VALUES (?,?,?,?,?)", (sha, name, "text/plain", len(data), i))
    con.commit()
    con.close()
    return shas


def unsafe_arcname_flags(name: str) -> list[str]:
    """Why an archive entry name could write outside the extraction
    directory or be read as a path another platform misreads."""
    flags = []
    if any(part == ".." for part in name.replace("\\", "/").split("/")):
        flags.append("dotdot")
    if name.startswith("/"):
        flags.append("absolute")
    if "\\" in name:
        flags.append("backslash")
    if "\x00" in name:
        flags.append("nul")
    if len(name) > 1 and name[1] == ":":
        flags.append("drive")
    if any(ord(ch) < 32 for ch in name):
        flags.append("control")
    return flags
