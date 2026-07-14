from pkm.importer.mermaid import convert_to_fence, is_mermaid_trigger
from pkm.importer.parse_export import Block


def _block(text, children=()):
    return Block(uid="u", text=text, heading=None, view_type=None, open=True,
                 created_at=None, edited_at=None, children=tuple(children))


def test_is_mermaid_trigger_both_spellings_and_whitespace():
    assert is_mermaid_trigger("{{[[mermaid]]}}")
    assert is_mermaid_trigger("{{mermaid}}")
    assert is_mermaid_trigger("  {{[[mermaid]]}}  ")
    assert is_mermaid_trigger(" {{mermaid}} ")


def test_is_mermaid_trigger_rejects_other_text():
    assert not is_mermaid_trigger("mermaid")
    assert not is_mermaid_trigger("{{[[mermaid]]}} extra")
    assert not is_mermaid_trigger("{{[[embed]]}}")
    assert not is_mermaid_trigger("")


def test_childless_mention_is_not_converted():
    assert convert_to_fence("{{[[mermaid]]}}", ()) is None
    assert convert_to_fence("{{mermaid}}", ()) is None


def test_non_trigger_text_with_children_is_not_converted():
    assert convert_to_fence("just some text", (_block("child"),)) is None


def test_simple_flat_diagram():
    component = _block("{{[[mermaid]]}}", (
        _block("flowchart TB"),
        _block("a --> b"),
    ))
    fence = convert_to_fence(component.text, component.children)
    assert fence == "```mermaid\nflowchart TB\na --> b\n```"


def test_bare_spelling_also_converts():
    component = _block("{{mermaid}}", (_block("flowchart TB"),))
    fence = convert_to_fence(component.text, component.children)
    assert fence == "```mermaid\nflowchart TB\n```"


def test_nested_subgraphs_indent_by_depth_and_preserve_order():
    component = _block("{{[[mermaid]]}}", (
        _block("flowchart TB"),
        _block("subgraph x[Group]", (
            _block("n1"),
            _block("n2", (
                _block("nested deeper"),
            )),
        )),
        _block("end"),
    ))
    fence = convert_to_fence(component.text, component.children)
    assert fence == (
        "```mermaid\n"
        "flowchart TB\n"
        "subgraph x[Group]\n"
        "  n1\n"
        "  n2\n"
        "    nested deeper\n"
        "end\n"
        "```"
    )


def test_trigger_with_surrounding_whitespace_still_converts():
    component = _block("  {{[[mermaid]]}}  ", (_block("flowchart TB"),))
    assert convert_to_fence(component.text, component.children) == (
        "```mermaid\nflowchart TB\n```"
    )
