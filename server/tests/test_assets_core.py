"""Pure asset-browser helpers (pkm-jdu3, pkm-x3l7)."""
import hashlib

import pytest

from pkm.assets_core import (
    asset_needs_repair, mime_category, sha256_hex, strip_asset_tokens,
    type_where, zip_arcnames)

SHA = "ab" * 32
URL = f"/assets/{SHA}/pic.png"


# --- strip_asset_tokens ---

def test_strips_image_token():
    assert strip_asset_tokens(f"diagram: ![alt]({URL})", SHA) == "diagram:"


def test_strips_link_token():
    assert (strip_asset_tokens(f"see [notes]({URL}) here", SHA)
            == "see here")


def test_strips_pdf_macro():
    assert strip_asset_tokens(f"{{{{[[pdf]]: {URL}}}}}", SHA) == ""


def test_strips_bare_url():
    assert strip_asset_tokens(f"raw {URL} link", SHA) == "raw link"


def test_strips_multiple_tokens_of_same_asset():
    text = f"![a]({URL}) and [b]({URL})"
    assert strip_asset_tokens(text, SHA) == "and"


def test_leaves_other_assets_alone():
    other = f"/assets/{'cd' * 32}/other.png"
    text = f"![keep]({other}) ![drop]({URL})"
    assert strip_asset_tokens(text, SHA) == f"![keep]({other})"


def test_leaves_page_links_alone():
    text = f"[[AI]] stuff ![x]({URL}) #tag"
    assert strip_asset_tokens(text, SHA) == "[[AI]] stuff #tag"


def test_no_token_is_identity_modulo_trim():
    assert strip_asset_tokens("plain text", SHA) == "plain text"


def test_image_only_block_becomes_empty():
    assert strip_asset_tokens(f"![]({URL})", SHA) == ""


# --- mime_category ---

@pytest.mark.parametrize("mime,cat", [
    ("image/png", "image"),
    ("image/heic", "image"),
    ("application/pdf", "pdf"),
    ("text/plain", "document"),
    ("text/csv", "document"),
    ("application/json", "document"),
    ("application/vnd.openxmlformats-officedocument"
     ".wordprocessingml.document", "document"),
    ("application/octet-stream", "other"),
])
def test_mime_category(mime, cat):
    assert mime_category(mime) == cat


# --- type_where: fragment must agree with mime_category ---

@pytest.mark.parametrize("mime", [
    "image/png", "application/pdf", "text/plain", "application/json",
    "application/vnd.ms-excel", "application/octet-stream",
])
@pytest.mark.parametrize("category", ["image", "pdf", "document", "other"])
def test_type_where_matches_mime_category(mime, category):
    import sqlite3
    db = sqlite3.connect(":memory:")
    db.execute("CREATE TABLE assets (mime TEXT)")
    db.execute("INSERT INTO assets VALUES (?)", (mime,))
    frag, params = type_where(category)
    n = db.execute(f"SELECT count(*) FROM assets WHERE {frag}",
                   params).fetchone()[0]
    assert (n == 1) == (mime_category(mime) == category)


# --- zip_arcnames ---

def test_zip_arcnames_no_collision_passthrough():
    entries: list[tuple[str, str]] = [("aa" * 32, "a.png"), ("bb" * 32, "b.png")]
    assert zip_arcnames(entries) == entries


def test_zip_arcnames_collision_gets_sha_prefix():
    entries: list[tuple[str, str]] = [("aa" * 32, "report.pdf"), ("bb" * 32, "report.pdf")]
    assert zip_arcnames(entries) == [
        ("aa" * 32, "report.pdf"),
        ("bb" * 32, f"report ({'bb' * 4}).pdf"),
    ]


def test_zip_arcnames_collision_is_case_insensitive():
    entries: list[tuple[str, str]] = [("aa" * 32, "Report.pdf"), ("bb" * 32, "report.pdf")]
    _, second = zip_arcnames(entries)[1]
    assert second == f"report ({'bb' * 4}).pdf"


# --- sha256_hex / asset_needs_repair (pkm-x3l7) ---

def test_sha256_hex_matches_hashlib():
    assert sha256_hex(b"hello") == hashlib.sha256(b"hello").hexdigest()


def test_needs_repair_false_when_size_and_hash_match():
    sha = sha256_hex(b"content")
    assert asset_needs_repair(sha, 7, 7, sha) is False


def test_needs_repair_true_on_size_mismatch_without_hashing():
    # A truncated file is detected from size alone -- callers must not
    # need to compute/pass a real hash to catch this case.
    sha = sha256_hex(b"content")
    assert asset_needs_repair(sha, 7, 3, None) is True


def test_needs_repair_true_on_same_size_hash_mismatch():
    # Same length, different bytes: only catchable once a hash is
    # actually computed and compared.
    sha = sha256_hex(b"content")
    other_sha = sha256_hex(b"CONTENT")
    assert asset_needs_repair(sha, 7, 7, other_sha) is True
