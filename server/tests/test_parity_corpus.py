import random

from pkm.parity_corpus import parity_corpus, piece_soup, shape_tally


def _letters(rng: random.Random) -> str:
    return rng.choice("abc") + rng.choice("ab")


def test_parity_corpus_draws_distinct_texts_in_draw_order():
    corpus = parity_corpus(_letters, seed=1, count=6)
    assert len(corpus) == 6
    assert len(set(corpus)) == 6
    rng = random.Random(1)
    drawn: list[str] = []
    while len(drawn) < 6:
        text = _letters(rng)
        if text not in drawn:
            drawn.append(text)
    assert corpus == drawn


def test_parity_corpus_honours_exclude():
    corpus = parity_corpus(_letters, seed=1, count=3,
                           exclude=("aa", "ba", "ca"))
    assert sorted(corpus) == ["ab", "bb", "cb"]


def test_parity_corpus_is_the_same_for_the_same_seed():
    assert (parity_corpus(_letters, seed=7, count=5)
            == parity_corpus(_letters, seed=7, count=5))
    assert (parity_corpus(_letters, seed=7, count=5)
            != parity_corpus(_letters, seed=8, count=5))


def test_piece_soup_draws_the_count_then_each_piece():
    pieces = ["x", "yy", "z"]
    rng = random.Random(3)
    want = "".join(rng.choice(pieces) for _ in range(rng.randint(2, 5)))
    assert piece_soup(pieces, 2, 5)(random.Random(3)) == want


def test_shape_tally_counts_each_shape():
    tally = shape_tally(iter(["a", "ab", "b"]), {
        "has_a": lambda t: "a" in t,
        "long": lambda t: len(t) > 1,
        "never": lambda t: False,
    })
    assert tally == {"has_a": 2, "long": 1, "never": 0}
