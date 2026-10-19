from pydantic import BaseModel

from pkm.contracts.titles import (
    CanonicalTitle,
    NormalizedTitle,
    RawTitle,
    as_raw_title,
)


class _Titles(BaseModel):
    a: RawTitle
    b: NormalizedTitle
    c: CanonicalTitle


def test_each_title_brand_carries_its_own_schema_marker() -> None:
    props = _Titles.model_json_schema()["properties"]
    assert props["a"]["x-brand"] == "RawTitle"
    assert props["b"]["x-brand"] == "NormalizedTitle"
    assert props["c"]["x-brand"] == "CanonicalTitle"


def test_as_raw_title_returns_the_text_unchanged() -> None:
    assert as_raw_title(" a\tb ") == " a\tb "
