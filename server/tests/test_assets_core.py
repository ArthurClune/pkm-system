"""Pure asset-browser helpers (pkm-jdu3, pkm-x3l7)."""
import hashlib

import pytest

from pkm.assets_core import (
    asset_needs_repair, classify_export_asset_transfer,
    export_limit_violation, mime_category, sha256_hex, strip_asset_tokens,
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


def _assert_all_unique_case_insensitive(arcs: list[tuple[str, str]]) -> None:
    lowered = [arc.lower() for _, arc in arcs]
    assert len(lowered) == len(set(lowered)), arcs


def test_zip_arcnames_generated_looking_name_still_gets_disambiguated():
    # A real original filename that happens to look like an
    # already-generated arcname (" (<sha8>)") must not silently collide
    # with a name zip_arcnames itself generates for a later entry that
    # shares the same 8-char sha prefix.
    sha_b = "bb" * 32
    entries: list[tuple[str, str]] = [
        ("aa" * 32, "report.pdf"),
        (sha_b, f"report ({sha_b[:8]}).pdf"),
        (sha_b, "report.pdf"),
    ]
    arcs = zip_arcnames(entries)
    _assert_all_unique_case_insensitive(arcs)


def test_zip_arcnames_shared_sha_prefix_still_gets_disambiguated():
    # Two distinct assets whose sha256 values share the same first 8
    # hex characters must not produce the same generated arcname when
    # both collide with an existing name.
    sha_x = "b" * 8 + "1" * 56
    sha_y = "b" * 8 + "2" * 56
    entries: list[tuple[str, str]] = [
        ("aa" * 32, "report.pdf"),
        (sha_x, "report.pdf"),
        (sha_y, "report.pdf"),
    ]
    arcs = zip_arcnames(entries)
    _assert_all_unique_case_insensitive(arcs)


def test_zip_arcnames_one_duplicate_resolves_by_prefix_extension():
    # Degenerate case: the same (sha, filename) pair appears twice.
    # A single duplicate is resolved by extending the sha prefix by one
    # character (8 -> 9), which is already a distinct string -- the
    # numeric-suffix fallback isn't needed yet at this scale.
    sha_b = "bb" * 32
    entries: list[tuple[str, str]] = [
        ("aa" * 32, "report.pdf"),
        (sha_b, "report.pdf"),
        (sha_b, "report.pdf"),
    ]
    arcs = zip_arcnames(entries)
    _assert_all_unique_case_insensitive(arcs)
    assert arcs[2][1] == f"report ({sha_b[:9]}).pdf"


def test_zip_arcnames_mass_duplicates_fall_back_to_numeric_suffix():
    # A 64-char hex sha only offers 57 distinct prefix lengths (8..64
    # inclusive). Once every one of those candidates for a single
    # repeated (sha, filename) pair is taken, extending the prefix
    # further can't produce a new string, so the numeric suffix
    # (" (<sha>-2)", " (<sha>-3)", ...) must take over. 60 duplicates
    # exhausts all 57 prefix lengths and forces 3 of them into the
    # numeric fallback.
    sha_b = "bb" * 32
    entries: list[tuple[str, str]] = [("aa" * 32, "report.pdf")]
    entries.extend((sha_b, "report.pdf") for _ in range(60))
    arcs = zip_arcnames(entries)
    _assert_all_unique_case_insensitive(arcs)
    assert sum(1 for _, arc in arcs if f"({sha_b}-" in arc) == 3


# --- sha256_hex / asset_needs_repair (pkm-x3l7) ---

@pytest.mark.parametrize(
    ("was_present", "expected"), [(False, "copied"), (True, "repaired")]
)
def test_classifies_export_asset_transfer(was_present, expected):
    assert classify_export_asset_transfer(was_present) == expected


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


# --- export_limit_violation (pkm-13ty) ---

def test_export_limit_violation_none_when_within_both_limits():
    assert export_limit_violation(5, 500, max_count=10, max_bytes=1000) is None


def test_export_limit_violation_at_exact_limits_is_ok():
    # A boundary of exactly the limit is allowed; only exceeding it refuses.
    assert export_limit_violation(10, 1000, max_count=10, max_bytes=1000) is None


def test_export_limit_violation_reports_count_over_limit():
    msg = export_limit_violation(11, 500, max_count=10, max_bytes=1000)
    assert msg is not None
    assert "11" in msg and "10" in msg


def test_export_limit_violation_reports_bytes_over_limit():
    msg = export_limit_violation(5, 1001, max_count=10, max_bytes=1000)
    assert msg is not None
    assert "1001" in msg and "1000" in msg


def test_export_limit_violation_checks_count_before_bytes():
    # Both limits are blown at once -- the count violation is reported
    # first (it's the cheaper, more legible number for a user to act on).
    msg = export_limit_violation(11, 1001, max_count=10, max_bytes=1000)
    assert msg is not None
    assert "11" in msg
