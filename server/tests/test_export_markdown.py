from pkm.export.markdown import (page_filename, render_page,
                                 resolve_block_refs, rewrite_asset_links,
                                 safe_filename)


def node(text, children=()):
    return {"text": text, "children": list(children)}


def test_render_nested_outline():
    tree = [node("parent", [node("child", [node("grandchild")])]),
            node("sibling")]
    assert render_page("My Page", tree, {}) == (
        "# My Page\n"
        "\n"
        "- parent\n"
        "  - child\n"
        "    - grandchild\n"
        "- sibling\n")


def test_render_multiline_block_continuation():
    assert render_page("P", [node("line one\nline two")], {}) == (
        "# P\n\n- line one\n  line two\n")


def test_block_refs_resolve_and_unknown_stay():
    text = "see ((uid_a)) and ((uid_gone))"
    out = resolve_block_refs(text, {"uid_a": "the target"})
    assert out == "see ((the target)) and ((uid_gone))"


def test_asset_links_become_relative():
    text = "![p](/assets/aa11/pic.png) and [d](/assets/bb22/doc.pdf)"
    assert rewrite_asset_links(text) == (
        "![p](../assets/aa11/pic.png) and [d](../assets/bb22/doc.pdf)")


def test_page_filename_sanitizes_and_dedupes():
    taken: set[str] = set()
    assert page_filename("Notes/Ideas: 2026", taken) == "Notes-Ideas- 2026.md"
    assert page_filename("plain", taken) == "plain.md"
    assert page_filename("Plain", taken) == "Plain (2).md"  # APFS case-insensitive
    assert page_filename("...", taken) == "untitled.md"


def test_safe_filename():
    assert safe_filename("a/b:c.png") == "a-b-c.png"
    assert safe_filename("") == "file"
