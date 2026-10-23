"""Round trip of GET /api/local-index over generated folders with hostile
file names: the listing is the visible regular files inside the root, every
listed href is served (or is an evicted stub), and nothing outside the root
is ever listed.

The model here is written from the generated spec, not from `visible_name`
or `walk_local_tree`: it knows what it put on disk and which names a person
would see. Names avoid pairs that APFS (normalisation-insensitive, case
-insensitive by default) would treat as the same entry."""
import errno
import os
import shutil
import unicodedata
from dataclasses import replace
from pathlib import Path

import pytest
from conftest import TEST_PASSWORD, asgi_get_all, make_config, seed_db
from fastapi.testclient import TestClient
from hypothesis import currently_in_test_context, example, given, settings
from hypothesis import event as _event
from hypothesis import strategies as st
from test_local_docs_props import _HOSTILE

from pkm.local_docs import LOCAL_PREFIX, resolve_relative
from pkm.server import routes_local
from pkm.server.app import create_app

STUB_SUFFIX = ".icloud"
MAX_NAME_BYTES = 255


def event(label: str) -> None:
    if currently_in_test_context():
        _event(label)


def _key(name: str) -> str:
    return unicodedata.normalize("NFC", name).casefold()


def _fits(name: str, extra: int = 0) -> bool:
    return len(name.encode("utf-8")) + extra <= MAX_NAME_BYTES


def _unlistable(name: str) -> bool:
    """A backslash or any control character (category Cc: C0, DEL, C1)
    makes a name one the routes cannot serve, so it is never listed."""
    return any(c == "\\" or unicodedata.category(c) == "Cc" for c in name)


def _model_shown(name: str) -> str | None:
    """What a person sees for a plain file called `name`, or None."""
    shown = name
    if name.startswith(".") and name.endswith(STUB_SUFFIX):
        shown = name[1:-len(STUB_SUFFIX)]
    if not shown or shown.startswith(".") or _unlistable(shown):
        return None
    return shown


# APFS refuses unassigned code points, so the free-text part of a file name
# draws from assigned letters, marks, numbers, punctuation, symbols, spaces.
_assigned_text = st.text(
    alphabet=st.characters(whitelist_categories=("L", "M", "N", "P", "S", "Z"),
                           blacklist_characters="/\x00"), min_size=1, max_size=10)
_hostile = st.lists(st.sampled_from(_HOSTILE), min_size=1, max_size=8).map("".join)
_tabby = st.text(alphabet="a\t b%", min_size=1, max_size=6)

fs_name = st.one_of(
    _hostile,
    _hostile,
    _assigned_text,
    _tabby,
    st.integers(100, 230).map(lambda n: "é" * (n // 2) + "z"),
    st.integers(100, 230).map(lambda n: "n" * n),
).map(lambda n: "x" + n if n in (".", "..") else n)
maybe_dot = st.sampled_from(["", "", "", "."])

KINDS = ["file", "file", "file", "hidden", "stub_only", "stub_only", "stub_beside",
         "stub_dotfile",
         "link_file_in", "link_file_out", "link_dir_out", "link_dir_in", "loop_up",
         "loop_pair"]

item = st.tuples(st.sampled_from(KINDS), st.integers(0, 6), maybe_dot, fs_name,
                 st.integers(0, 50))
plan = st.tuples(
    st.lists(st.tuples(st.integers(0, 6), maybe_dot, fs_name), max_size=5),
    st.lists(item, max_size=14))


class Built:
    def __init__(self, root: Path, outside: Path) -> None:
        self.root = root
        self.outside = outside
        self.dirs: list[tuple[str, ...]] = [()]
        self.used: dict[tuple[str, ...], set[str]] = {(): set()}
        self.content: dict[tuple[tuple[str, ...], str], bytes] = {}
        self.shown: list[tuple[tuple[str, ...], str]] = []  # (dir, on-disk name)
        self.aliases = False
        self.serial = 0

    def abs(self, d: tuple[str, ...], name: str | None = None) -> Path:
        p = self.root.joinpath(*d)
        return p / name if name is not None else p

    def free(self, d: tuple[str, ...], *names: str) -> bool:
        return all(_key(n) not in self.used[d] for n in names)

    def claim(self, d: tuple[str, ...], *names: str) -> None:
        self.used[d].update(_key(n) for n in names)

    def write(self, d: tuple[str, ...], name: str) -> None:
        self.serial += 1
        data = f"{self.serial}:{name}".encode()
        self.abs(d, name).write_bytes(data)
        self.content[(d, name)] = data


def _wipe(folder: Path) -> None:
    folder.mkdir(exist_ok=True)
    for child in folder.iterdir():
        if child.is_symlink() or child.is_file():
            child.unlink()
        else:
            shutil.rmtree(child)


def build(root: Path, outside: Path, spec) -> Built:
    _wipe(root)
    _wipe(outside)
    b = Built(root, outside)
    (outside / "secret.txt").write_bytes(b"outside-secret")
    (outside / "dir").mkdir()
    (outside / "dir" / "inner.txt").write_bytes(b"outside-inner")
    dir_specs, items = spec
    for hint, dot, name in dir_specs:
        parent = b.dirs[hint % len(b.dirs)]
        name = dot + name
        if name in (".", "..") or not _fits(name) or not b.free(parent, name):
            continue
        try:
            b.abs(parent, name).mkdir()
        except OSError as e:
            if e.errno != errno.EILSEQ:
                raise
            event("name refused by the filesystem")
            continue
        b.claim(parent, name)
        child = parent + (name,)
        b.dirs.append(child)
        b.used[child] = set()
        event("hidden dir" if name.startswith(".") else "visible dir")
    for kind, hint, dot, base, pick in items:
        d = b.dirs[hint % len(b.dirs)]
        name = dot + base
        if name in (".", "..") or not _fits(name):
            continue
        if len(d) >= 2:
            event("nested")
        try:
            _item(b, kind, d, name, pick)
        except OSError as e:
            # APFS refuses some code points (unassigned ones) outright.
            if e.errno != errno.EILSEQ:
                raise
            event("name refused by the filesystem")
    return b


def _item(b: Built, kind: str, d: tuple[str, ...], name: str, pick: int) -> None:
    files = sorted(k for k in b.content if not k[1].endswith(STUB_SUFFIX))
    stubs = lambda real: f".{real}{STUB_SUFFIX}"  # noqa: E731
    if kind in ("file", "hidden"):
        name = "." + name.lstrip(".") if kind == "hidden" else name
        # an all-dot name folds to "." (the folder itself), not a file
        if name == "." or not b.free(d, name):
            return
        shown = _model_shown(name)
        if shown is not None and not b.free(d, shown):
            return
        b.claim(d, name, *([shown] if shown else []))
        b.write(d, name)
        event("hidden file" if shown is None else "plain file")
    elif kind in ("stub_only", "stub_beside", "stub_dotfile"):
        real = "." + name.lstrip(".") if kind == "stub_dotfile" else name.lstrip(".")
        if not real or not _fits(real, len(stubs(""))):
            return
        stub = stubs(real)
        if kind == "stub_beside":
            if not b.free(d, real, stub):
                return
            b.claim(d, real, stub)
            b.write(d, real)
            b.write(d, stub)
            event("stub beside real")
            return
        if not b.free(d, stub, *([real] if not real.startswith(".") else [])):
            return
        b.claim(d, stub, *([real] if not real.startswith(".") else []))
        b.write(d, stub)
        event("stub of dotfile" if real.startswith(".") else "stub only")
    elif kind == "link_file_in":
        shown = _model_shown(name)
        if not files or not b.free(d, name) or (shown and not b.free(d, shown)):
            return
        td, tn = files[pick % len(files)]
        os.symlink(b.abs(td, tn), b.abs(d, name))
        b.claim(d, name, *([shown] if shown else []))
        b.content[(d, name)] = b.content[(td, tn)]
        event("symlink file in")
    elif kind == "link_file_out":
        if not b.free(d, name):
            return
        os.symlink(b.outside / "secret.txt", b.abs(d, name))
        b.claim(d, name)
        event("symlink file out")
    elif kind == "link_dir_out":
        if not b.free(d, name):
            return
        os.symlink(b.outside / "dir", b.abs(d, name))
        b.claim(d, name)
        event("symlink dir out")
    elif kind == "link_dir_in":
        real_dirs = [x for x in b.dirs if x]
        if not real_dirs or not b.free(d, name):
            return
        os.symlink(b.abs(real_dirs[pick % len(real_dirs)]), b.abs(d, name))
        b.claim(d, name)
        if not name.startswith("."):
            b.aliases = True
        event("symlink dir in")
    elif kind == "loop_up":
        if not b.free(d, name):
            return
        target = b.abs(d[:pick % (len(d) + 1)])
        os.symlink(target, b.abs(d, name))
        b.claim(d, name)
        event("loop to ancestor")
    else:  # loop_pair
        other = name + "~"
        if not _fits(other) or not b.free(d, name, other):
            return
        os.symlink(other, b.abs(d, name))
        os.symlink(name, b.abs(d, other))
        b.claim(d, name, other)
        event("loop pair")


def model_listing(b: Built) -> set[str]:
    """Visible regular files, ignoring directory symlinks entirely."""
    out = set()
    for (d, name), _ in b.content.items():
        shown = _model_shown(name)
        if shown is not None and all(not seg.startswith(".") and not _unlistable(seg) for seg in d):
            out.add("/".join((*d, shown)))
    return out


def _identity(root: Path, rel: str) -> Path | None:
    """Where a listed path really lives: the file, or its evicted stub."""
    p = root / rel
    if p.is_file():
        return p.resolve()
    stub = p.parent / f".{p.name}{STUB_SUFFIX}"
    return stub.resolve() if stub.is_file() else None


def _tag_built(b: Built) -> None:
    names = [n for (_, n) in b.content] + [seg for d in b.dirs for seg in d]
    for n in names:
        if "\\" in n:
            event("unlistable: backslash")
        if any(unicodedata.category(c) == "Cc" for c in n):
            event("unlistable: control char")
        if "\n" in n:
            event("unlistable: newline")


def _tag_names(rels: set[str]) -> None:
    for rel in rels:
        for seg in rel.split("/"):
            if unicodedata.normalize("NFD", seg) != seg:
                event("nfd name")
            if any(ord(c) > 0xFFFF for c in seg):
                event("emoji name")
            if len(seg.encode()) > 100:
                event("long name")
            if "\t" in seg:
                event("tab name")
            if "[" in seg or "]" in seg:
                event("bracket name")
            if any(c in seg for c in "%#?&+"):
                event("url metachar name")


@pytest.fixture(scope="module")
def local_props_client(tmp_path_factory):
    base = tmp_path_factory.mktemp("localprops").resolve()
    config = make_config(base)
    seed_db(config.db_path)
    root = base / "root"
    root.mkdir()
    config = replace(config, local_docs_root=root)
    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(routes_local, "_request_download", lambda p: None)
        app = create_app(config)
        login = TestClient(app).post("/api/login", json={"password": TEST_PASSWORD})
        assert login.status_code == 200
        yield app, login.cookies["pkm_session"], root, base / "outside"


@settings(max_examples=250, deadline=None)
@given(plan)
# an all-dot hidden name once folded to "." and wrote to the folder itself
@example(([], [("hidden", 0, "", "...", 0)]))
def test_index_lists_the_visible_files_and_each_is_served(local_props_client, spec):
    app, cookie, root, outside = local_props_client
    b = build(root, outside, spec)
    (r,) = (asgi_get_all(app, cookie, ["/api/local-index"]))
    assert r.status_code == 200
    listed = [f["path"] for f in r.json()["files"]]
    hrefs = {f["path"]: f["href"] for f in r.json()["files"]}
    expected = model_listing(b)
    _tag_built(b)
    _tag_names(set(listed))
    if not listed:
        event("empty listing")

    assert len(listed) == len(set(listed))
    assert listed == sorted(listed, key=lambda s: (s.casefold(), s))
    for p, href in hrefs.items():
        assert href.startswith(LOCAL_PREFIX)
        assert resolve_relative(href[len(LOCAL_PREFIX):]) == p

    # Nothing outside the root is ever listed, and nothing listed is hidden.
    for p in listed:
        ident = _identity(root, p)
        assert ident is not None, p
        assert ident.is_relative_to(root), p
        assert not any(seg.startswith(".") for seg in p.split("/")), p

    if b.aliases:
        # A directory symlink inside the root is entered once, so its files
        # show under whichever alias the walk met first. What must hold: every
        # file visible through real directories is listed under some path
        # with the same identity.
        event("aliased tree")
        want = {_identity(root, p) for p in expected}
        assert want <= {_identity(root, p) for p in listed}
    else:
        assert set(listed) == expected

    served = (asgi_get_all(app, cookie, [hrefs[p] for p in listed]))
    for p, got in zip(listed, served):
        d, _, name = p.rpartition("/")
        key = (tuple(d.split("/")) if d else (), name)
        want_bytes = b.content.get(key)
        if want_bytes is None and not b.aliases:
            assert got.status_code == 503, (p, got.status_code)
            event("stub served as 503")
        elif want_bytes is None:
            assert got.status_code in (200, 503), (p, got.status_code)
        else:
            assert got.status_code == 200, (p, got.status_code)
            assert got.content == want_bytes
            event("served 200")

