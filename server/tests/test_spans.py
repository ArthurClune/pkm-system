from hypothesis import given, strategies as st

from pkm.spans import Span, splice, spliced_length


def _one_at_a_time(text: str, spans: list[Span]) -> str:
    for start, end, replacement in sorted(spans, reverse=True):
        text = text[:start] + replacement + text[end:]
    return text


@st.composite
def _cases(draw: st.DrawFn) -> tuple[str, list[Span]]:
    text = draw(st.text("abc", max_size=12))
    spans: list[Span] = []
    for _ in range(draw(st.integers(0, 4))):
        start = draw(st.integers(0, len(text)))
        end = draw(st.integers(start, len(text)))
        spans.append((start, end, draw(st.text("XY", max_size=3))))
    return text, spans


@given(_cases())
def test_splice_matches_splicing_one_span_at_a_time(case):
    # overlapping spans included: they keep the old back-to-front result
    text, spans = case
    assert splice(text, spans) == _one_at_a_time(text, spans)


def test_spliced_length_is_the_length_of_the_splice():
    text = "see [[a]] and [[a]]"
    spans: list[Span] = [(4, 9, "[[long]]"), (14, 19, "")]
    assert spliced_length(text, spans) == len(splice(text, spans))
