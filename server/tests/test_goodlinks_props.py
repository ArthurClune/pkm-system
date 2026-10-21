"""Properties of the pure GoodLinks href helpers: an id round-trips
through its href, hrefs are found in surrounding block text, and ids that
miss the 32-lowercase-hex shape by one character are refused."""
from hypothesis import event, given, settings
from hypothesis import strategies as st

from pkm.goodlinks import (GOODLINKS_PREFIX, extract_goodlinks_hrefs,
                           goodlinks_href, link_id_from_href, parse_link_id)

valid_id = st.text(alphabet="0123456789abcdef", min_size=32, max_size=32)

# text that cannot itself contain a goodlinks or local href
prose = st.text(
    alphabet=st.characters(blacklist_categories=("Cs",)), max_size=20,
).filter(lambda t: "/api/" not in t)


def _near_misses(good: str):
    """Ids one edit away from valid: wrong case, wrong length, a non-hex or
    line-break character, an unicode digit."""
    return st.one_of(
        st.integers(0, 31).map(lambda i: good[:i] + good[i].upper() + good[i + 1:]
                               if good[i].isalpha() else good.upper() + "A"),
        st.integers(0, 31).map(lambda i: good[:i] + good[i + 1:]),
        st.sampled_from(["0", "a", "\n", " ", "g", "٣"]).map(lambda c: good + c),
        st.tuples(st.integers(0, 31), st.sampled_from(["g", "G", "\n", " ", "٣", "-", "/", "%"]))
        .map(lambda t: good[:t[0]] + t[1] + good[t[0] + 1:]),
        st.just(""),
    )


@settings(max_examples=300, deadline=None)
@given(valid_id)
def test_id_round_trips_through_its_href(raw):
    link_id = parse_link_id(raw)
    assert link_id == raw
    assert link_id is not None
    assert link_id_from_href(goodlinks_href(link_id)) == raw


@settings(max_examples=300, deadline=None)
@given(valid_id, st.data())
def test_near_miss_ids_are_refused(raw, data):
    bad = data.draw(_near_misses(raw))
    event("uppercase" if bad.upper() == bad and bad != bad.lower() else "other near miss")
    assert parse_link_id(bad) is None
    assert link_id_from_href(GOODLINKS_PREFIX + bad) is None


@settings(max_examples=300, deadline=None)
@given(valid_id, st.sampled_from(["", "x", "x/", "?", "#", "/"]), st.sampled_from(
    ["/api/goodlinks/", "/api/goodlinks", "api/goodlinks/", "/api/Goodlinks/", "/api/local/",
     "http://h/api/goodlinks/"]))
def test_hrefs_with_extra_or_wrong_prefix_are_refused(raw, junk, prefix):
    href = prefix + junk + raw
    if href == GOODLINKS_PREFIX + raw:
        return
    assert link_id_from_href(href) is None


@settings(max_examples=300, deadline=None)
@given(st.lists(valid_id, min_size=1, max_size=4), prose, prose, prose,
       st.sampled_from(["link", "bare"]))
def test_extract_finds_each_href_once_in_order(ids, before, between, after, form):
    event(form)
    hrefs = [goodlinks_href(parse_link_id(i)) for i in ids]  # type: ignore[arg-type]
    if form == "link":
        parts = [f"[{between}]({h})" for h in hrefs]
    else:
        parts = [f" {h} " for h in hrefs]
    # the same href repeated must be reported once
    text = before + between.join(parts + parts[:1]) + after
    want = list(dict.fromkeys(hrefs))
    assert extract_goodlinks_hrefs(text) == want
