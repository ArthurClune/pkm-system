from pkm.echo import echo, loc_text


def test_echo_quotes_a_short_value():
    assert echo("a") == '"a"'


def test_echo_cuts_a_long_value_and_says_how_long():
    assert echo("x" * 2_000_000) == (
        '"' + "x" * 80 + '"\u2026 (2,000,000 characters)')


def test_echo_escapes_line_separators():
    assert echo("a\u2028b") == '"a\\u2028b"'


def test_loc_text_bounds_an_overlong_key():
    assert loc_text(["params", "k" * 1000]) == "params." + echo("k" * 1000)


def test_loc_text_joins_with_dots():
    assert loc_text(["commands", 0]) == "commands.0"
