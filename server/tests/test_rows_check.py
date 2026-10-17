from pkm.rows import row_problems


def test_a_well_formed_row_has_no_problems():
    assert row_problems({"uid": "abcdef"}) == []


def test_a_brand_shape_failure_names_the_key_and_brand():
    (problem,) = row_problems({"uid": "a"})
    assert "uid" in problem and "BlockUid" in problem


def test_null_in_a_non_null_key_is_reported():
    (problem,) = row_problems({"page_id": None})
    assert "page_id" in problem and "NULL" in problem


def test_null_in_a_nullable_key_is_fine():
    assert row_problems({"parent_uid": None}) == []


def test_bool_is_not_an_int():
    (problem,) = row_problems({"page_id": True})
    assert "page_id" in problem and "bool" in problem


def test_an_unregistered_column_is_reported():
    (problem,) = row_problems({"nope": 1})
    assert "nope" in problem and "not a registered row key" in problem


def test_a_base_type_mismatch_is_reported():
    (problem,) = row_problems({"text": 3})
    assert "text" in problem and "expected str" in problem


def test_a_sha_must_be_lowercase_hex_of_full_length():
    assert row_problems({"sha256": "0" * 64}) == []
    assert row_problems({"sha256": "0" * 63}) != []


def test_a_subtype_brand_reads_as_its_base():
    assert row_problems({"title": "Some page"}) == []


def test_a_literal_member_is_fine():
    assert row_problems({"rewrite_kind": "unlink", "heading": 2,
                         "view_type": None}) == []


def test_a_value_outside_a_literal_is_reported():
    (problem,) = row_problems({"heading": 0})
    assert "heading" in problem and "1, 2, 3" in problem
    (problem,) = row_problems({"ref_kind": "nope"})
    assert "ref_kind" in problem and "'link'" in problem
