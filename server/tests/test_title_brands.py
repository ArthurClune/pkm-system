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


def _brand_of(model: type[BaseModel], field: str) -> object:
    prop = model.model_json_schema()["properties"][field]
    if "x-brand" in prop:
        return prop["x-brand"]
    return {b["x-brand"] for b in prop["anyOf"] if "x-brand" in b}


def test_raw_title_request_fields_are_branded() -> None:
    from pkm.contracts.ops import CreateOp, CreatePageOp, MoveOp, UpdateTextOp
    from pkm.server.routes_pages import CreatePageRequest, RenamePageRequest
    from pkm.server.routes_sidebar import AddSidebarEntryRequest

    assert _brand_of(CreatePageRequest, "title") == "RawTitle"
    assert _brand_of(RenamePageRequest, "new_title") == "RawTitle"
    assert _brand_of(AddSidebarEntryRequest, "title") == "RawTitle"
    assert _brand_of(CreateOp, "page_title") == "RawTitle"
    assert _brand_of(CreatePageOp, "page_title") == "RawTitle"
    assert _brand_of(UpdateTextOp, "page_title") == {"RawTitle"}
    assert _brand_of(MoveOp, "page_title") == {"RawTitle"}


def test_empty_raw_title_is_still_rejected() -> None:
    import pytest
    from pydantic import ValidationError

    from pkm.contracts.ops import CreateOp
    from pkm.server.routes_pages import CreatePageRequest

    with pytest.raises(ValidationError):
        CreatePageRequest(title=as_raw_title(""))
    with pytest.raises(ValidationError):
        CreateOp.model_validate({
            "op": "create", "uid": "u" * 9, "page_title": "",
            "order_idx": "a0", "text": ""})


def test_delete_blocker_page_title_is_canonical() -> None:
    from pkm.contracts.responses import DeleteBlockerModel

    assert _brand_of(DeleteBlockerModel, "page_title") == "CanonicalTitle"
