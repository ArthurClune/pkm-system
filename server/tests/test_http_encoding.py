import gzip

import pytest
from hypothesis import given
from hypothesis import strategies as st

from pkm.server.http_encoding import GZIP_MIN_BYTES, accepts_gzip, encode_body


@pytest.mark.parametrize("header,expected", [
    (None, False),
    ("", False),
    ("identity", False),
    ("gzip", True),
    ("GZip", True),
    ("  gzip  ", True),
    ("x-gzip", True),
    ("gzip, deflate", True),
    ("deflate, br", False),
    ("gzip;q=0", False),
    ("gzip;q=0.0", False),
    ("gzip; q=0.5", True),
    ("gzip;q=0.001", True),
    ("*", True),
    ("*;q=0", False),
    ("*;q=0.1", True),
    ("*, gzip;q=0", False),
    ("gzip;q=0, *", False),
    ("*;q=0, gzip", True),
    ("gzip;q=abc", False),
    ("gzip;q=abc, *", True),
    ("gzip;q=", False),
    ("gzip;q=2", False),
    ("gzip;q=-1", False),
    (",,gzip,,", True),
])
def test_accepts_gzip(header, expected):
    assert accepts_gzip(header) is expected


@given(st.one_of(st.none(), st.text()))
def test_accepts_gzip_never_raises(header):
    assert isinstance(accepts_gzip(header), bool)


def test_a_large_body_is_gzipped_with_a_deterministic_stream():
    body = b"x" * (GZIP_MIN_BYTES + 1)
    out, headers = encode_body(body, "gzip")
    assert gzip.decompress(out) == body
    assert headers["Content-Encoding"] == "gzip"
    assert headers["Vary"] == "Accept-Encoding"
    assert encode_body(body, "gzip")[0] == out


def test_a_body_under_the_floor_stays_plain_but_still_varies():
    body = b"x" * (GZIP_MIN_BYTES - 1)
    out, headers = encode_body(body, "gzip")
    assert out == body
    assert headers == {"Vary": "Accept-Encoding"}


def test_a_client_that_refuses_gzip_gets_the_plain_body():
    body = b"x" * (GZIP_MIN_BYTES * 2)
    out, headers = encode_body(body, "gzip;q=0")
    assert out == body
    assert "Content-Encoding" not in headers
    assert headers["Vary"] == "Accept-Encoding"
