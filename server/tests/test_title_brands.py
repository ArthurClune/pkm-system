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
    if "anyOf" not in prop:
        return None
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


def _title_errors(model: type[BaseModel], payload: dict[str, object]) -> set[tuple[object, ...]]:
    from pydantic import ValidationError

    try:
        model.model_validate(payload)
    except ValidationError as exc:
        return {tuple(e["loc"]) for e in exc.errors()}
    return set()


def test_empty_raw_title_is_still_rejected() -> None:
    from pkm.contracts.ops import CreateOp, CreatePageOp, MoveOp
    from pkm.server.routes_pages import CreatePageRequest, RenamePageRequest
    from pkm.server.routes_sidebar import AddSidebarEntryRequest

    uid = "tuid_aaaa1"
    cases: list[tuple[type[BaseModel], dict[str, object], str]] = [
        (CreateOp, {"op": "create", "uid": uid, "order_idx": 0, "text": ""},
         "page_title"),
        (CreatePageOp, {"op": "create_page"}, "page_title"),
        (MoveOp, {"op": "move", "uid": uid, "parent_uid": None,
                  "order_idx": 0}, "page_title"),
        (CreatePageRequest, {}, "title"),
        (RenamePageRequest, {}, "new_title"),
        (AddSidebarEntryRequest, {}, "title"),
    ]
    for model, base, field in cases:
        assert _title_errors(model, {**base, field: "x"}) == set(), model
        assert _title_errors(model, {**base, field: ""}) == {(field,)}, model


def test_delete_blocker_page_title_is_canonical() -> None:
    from pkm.contracts.responses import DeleteBlockerModel

    assert _brand_of(DeleteBlockerModel, "page_title") == "CanonicalTitle"


def test_non_page_titles_are_not_named_title() -> None:
    from pkm.contracts.responses import (CurrentWorkSection, GoodlinksArticle,
                                         GoodlinksLink)
    assert "title" not in CurrentWorkSection.model_fields
    assert "heading" in CurrentWorkSection.model_fields
    for model in (GoodlinksLink, GoodlinksArticle):
        assert "title" not in model.model_fields
        assert "article_title" in model.model_fields


def test_route_title_params_are_raw(client) -> None:
    paths = client.app.openapi()["paths"]
    routes = [("/api/page/{title}", "get"), ("/api/page/{title}", "delete"),
              ("/api/delete-preview", "get"),
              ("/api/page/{title}/rename", "post"),
              ("/api/unlinked", "get"), ("/api/export/page/{title}", "get")]
    for path, method in routes:
        params = {p["name"]: p for p in paths[path][method]["parameters"]}
        assert params["title"]["schema"]["x-brand"] == "RawTitle", (path, method)
