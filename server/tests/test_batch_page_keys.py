from pkm.batch import page_keys
from pkm.contracts.titles import UNTITLED_PAGE_TITLE, as_raw_title


def _keys(*spellings: str, plain_space: bool | None):
    raw = [as_raw_title(s) for s in spellings]
    return page_keys(raw, plain_space)


def test_blank_spellings_and_untitled_share_one_key():
    for plain_space in (None, False, True):
        keys = _keys("\n", "  ", "Untitled", "\t \n", plain_space=plain_space)
        assert set(keys.values()) == {UNTITLED_PAGE_TITLE}, plain_space


def test_a_nonblank_spelling_keeps_its_folded_key():
    keys = _keys("Foo\nBar", "Foo Bar", plain_space=None)
    assert set(keys.values()) == {as_raw_title("Foo Bar")}
