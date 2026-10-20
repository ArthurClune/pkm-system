import ast
import dataclasses
import subprocess
from pathlib import Path

import pytest

from brandlint.core import _glob_to_regex, check_text
from brandlint.registry import load_registry

REPO = Path(__file__).resolve().parents[2]
REGISTRY = load_registry(REPO)
TRACKED = subprocess.run(["git", "-C", str(REPO), "ls-files"], check=True, capture_output=True,
                         text=True).stdout.splitlines()


def under(site: str) -> list[str]:
    """The tracked files a registry site names: the file, or those under a
    directory prefix ending `/`."""
    return [p for p in TRACKED if p == site or (site.endswith("/") and p.startswith(site))]


def text_of(path: str) -> str:
    return (REPO / path).read_text(encoding="utf-8")


def without(sites: tuple[str, ...], site: str) -> tuple[str, ...]:
    return tuple(s for s in sites if s != site)


MINT = [(brand, site) for brand, sites in REGISTRY.mint_sites.items() for site in sites]
SERVER_MINT = [(b, s) for b, s in MINT if s.startswith("server/") and s.endswith(".py")]


@pytest.mark.parametrize(("brand", "site"), MINT)
def test_a_mint_site_exists(brand: str, site: str):
    """A web site mints through generated or generic types that do not name
    the brand, so only its existence is checkable here."""
    assert under(site), f"{site} is a MINT_SITES entry for {brand} but no tracked file matches"


@pytest.mark.parametrize(("brand", "site"), SERVER_MINT)
def test_a_server_mint_site_still_mints_its_brand(brand: str, site: str):
    if brand in REGISTRY.declared and brand in _declares(site):
        return
    stripped = dataclasses.replace(
        REGISTRY, mint_sites={**REGISTRY.mint_sites, brand: without(REGISTRY.mint_sites[brand], site)})
    found = [v for v in check_text(site, text_of(site), stripped) if v.rule == "brand-mint" and brand in v.text]
    assert found, f"{site} is a MINT_SITES entry for {brand} but no longer mints it"


def _declares(site: str) -> set[str]:
    tree = ast.parse(text_of(site))
    return {t.id for n in ast.walk(tree) if isinstance(n, ast.Assign) for t in n.targets
            if isinstance(t, ast.Name) and isinstance(n.value, ast.Call)
            and getattr(n.value.func, "id", getattr(n.value.func, "attr", "")) == "NewType"}


@pytest.mark.parametrize("site", REGISTRY.cast_sites)
def test_a_cast_site_still_casts(site: str):
    assert under(site), f"{site} is a CAST_SITES entry but no tracked file matches"
    stripped = dataclasses.replace(REGISTRY, cast_sites=without(REGISTRY.cast_sites, site))
    found = [v for v in check_text(site, text_of(site), stripped) if v.rule == "brand-cast"]
    assert found, f"{site} is a CAST_SITES entry but no longer calls cast"


@pytest.mark.parametrize("site", REGISTRY.sqlite_sites)
def test_a_sqlite_site_still_touches_raw_sqlite(site: str):
    files = [p for p in under(site) if p.endswith(".py")]
    assert files, f"{site} is a SQLITE_SITES entry but no tracked Python file matches"
    stripped = dataclasses.replace(REGISTRY, sqlite_sites=without(REGISTRY.sqlite_sites, site))
    assert any(v.rule == "raw-sqlite" for p in files for v in check_text(p, text_of(p), stripped)), \
        f"nothing under {site} touches raw sqlite any more"


def _camel(stem: str) -> str:
    head, *rest = stem.split("_")
    return head + "".join(part.capitalize() for part in rest)


@pytest.mark.parametrize("site", REGISTRY.test_mint_sites)
def test_a_test_mint_site_has_a_helper_for_each_brand_it_serves(site: str):
    """The server module serves every brand declared in the server; the web
    one every brand with a web mint site."""
    assert under(site), f"{site} is a TEST_MINT_SITES entry but no tracked file matches"
    text = text_of(site)
    for brand, stem in REGISTRY.test_helpers.items():
        if site.startswith("server/"):
            serves, helper = brand in REGISTRY.declared, f"def {stem}_of("
        else:
            serves = any(s.startswith("web/") for s in REGISTRY.mint_sites.get(brand, ()))
            helper = f"function {_camel(stem)}Of("
        assert not serves or helper in text, f"{site} lacks `{helper}` for {brand}"


@pytest.mark.parametrize("site", REGISTRY.test_code)
def test_a_test_code_site_exists(site: str):
    assert under(site), f"{site} is a TEST_CODE entry but no tracked file matches"


@pytest.mark.parametrize("pattern", REGISTRY.opt_out_files)
def test_an_opt_out_file_still_has_an_opt_out(pattern: str):
    matches = [p for p in TRACKED if _glob_to_regex(pattern).match(p)]
    assert matches, f"{pattern} is an OPT_OUT_FILES entry but matches no tracked file"
    assert any("brand: untrusted --" in text_of(p) for p in matches), \
        f"no file matching {pattern} carries an opt-out any more"


def test_the_strict_base_exists():
    assert REGISTRY.strict_base is not None
    path, name = REGISTRY.strict_base
    assert under(path), f"{path} is STRICT_BASE's file but no tracked file matches"
    assert f"class {name}(BaseModel)" in text_of(path), f"{path} no longer defines {name}"


def test_a_missing_strict_base_class_is_reported():
    """The check above fails when the class is renamed: its text no longer
    matches, and the rule would then flag the renamed class."""
    assert REGISTRY.strict_base is not None
    path, name = REGISTRY.strict_base
    renamed = text_of(path).replace(name, "Renamed")
    assert [v.rule for v in check_text(path, renamed, REGISTRY)] == ["model-strict"]
