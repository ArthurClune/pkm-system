import pytest

from pkm.client.core import (ApiError, CliConfig, ConfigError, cookie_header,
                             friendly_error, parse_config, serialize_config)


def test_config_round_trip():
    cfg = CliConfig(url="http://127.0.0.1:8974", token="v1.123.abc")
    assert parse_config(serialize_config(cfg)) == cfg


def test_parse_config_rejects_bad_json_and_missing_keys():
    with pytest.raises(ConfigError):
        parse_config("not json")
    with pytest.raises(ConfigError):
        parse_config('{"url": "http://x"}')
    with pytest.raises(ConfigError):
        parse_config('{"url": "", "token": "t"}')


def test_parse_config_strips_trailing_slash():
    cfg = parse_config('{"url": "http://x:1/", "token": "t"}')
    assert cfg.url == "http://x:1"


def test_cookie_header():
    assert cookie_header("tok") == {"Cookie": "pkm_session=tok"}


def test_friendly_error_401_suggests_login():
    assert friendly_error(401, "unauthorized") == (
        "session expired or missing — run `pkm login`")


def test_friendly_error_renders_ops_detail_dict():
    assert friendly_error(
        400, {"index": 2, "reason": "block not found: x"}
    ) == "op 2: block not found: x"


def test_friendly_error_plain_detail():
    assert friendly_error(404, "page not found") == "page not found"


def test_api_error_carries_status_message_and_single_prefix():
    e = ApiError(409, "conflict")
    assert (e.status, e.message) == (409, "conflict")
    assert str(e) == "409: conflict"


def test_api_error_status_zero_has_one_prefix():
    assert str(ApiError(0, "network unavailable")) == "0: network unavailable"
