from pkm.filenames import MAX_EXTENSION_BYTES, MAX_FILENAME_BYTES, safe_filename


def test_safe_filename_sanitizes_unsafe_chars():
    assert safe_filename("a/b:c.png") == "a-b-c.png"


def test_safe_filename_empty_falls_back_to_default_stem():
    assert safe_filename("") == "file"


def test_safe_filename_dot_and_dotdot_fall_back_to_default_stem():
    assert safe_filename(".") == "file"
    assert safe_filename("..") == "file"


def test_safe_filename_whitespace_only_falls_back_to_default_stem():
    assert safe_filename("   ") == "file"


def test_safe_filename_extension_only_gets_default_stem():
    # A name that's only an extension (no real basename) still needs a
    # usable, non-empty filename.
    assert safe_filename(".png") == "file.png"


def test_safe_filename_truncates_overlong_ascii_preserving_extension():
    name = safe_filename("x" * 300 + ".png")
    assert name.endswith(".png")
    assert len(name.encode("utf-8")) <= MAX_FILENAME_BYTES


def test_safe_filename_truncation_respects_multibyte_boundaries():
    # "é" is 2 bytes in UTF-8: 120 chars is under any char-based limit but
    # 240 (stem) + 4 (.png) = 244 bytes is over MAX_FILENAME_BYTES.
    name = safe_filename("é" * 120 + ".png")
    assert len(name.encode("utf-8")) <= MAX_FILENAME_BYTES
    assert name.endswith(".png")
    name.encode("utf-8").decode("utf-8")  # no split code point


def test_safe_filename_bounds_pathological_extension():
    name = safe_filename("file." + "x" * 300)
    assert len(name.encode("utf-8")) <= MAX_FILENAME_BYTES
    ext = name.split(".", 1)[1]
    assert len(ext.encode("utf-8")) <= MAX_EXTENSION_BYTES


def test_safe_filename_truncation_can_collide():
    # Two distinct overlong names can truncate to the same result; callers
    # that need uniqueness (e.g. content-addressed asset directories) must
    # not rely on safe_filename() alone to prevent collisions.
    a = safe_filename("A" * 250 + ".png")
    b = safe_filename("A" * 250 + "Z" * 50 + ".png")
    assert a == b


def test_fs_dedupe_key_is_at_least_as_strict_as_the_filesystem(tmp_path):
    # Whenever the filesystem keeps one file for two names, the keys must
    # be equal; the converse only adds a "(2)" suffix.
    from pkm.filenames import fs_dedupe_key
    pairs = [("café", "café"), ("Straße", "STRASSE"),
             ("ς", "σ"), ("ﬀ", "ff"), ("K", "K"),
             ("ǅ", "ǆ"), ("a", "A")]
    for i, (a, b) in enumerate(pairs):
        d = tmp_path / str(i)
        d.mkdir()
        (d / a).write_text("1")
        (d / b).write_text("2")
        if len(list(d.iterdir())) == 1:
            assert fs_dedupe_key(a) == fs_dedupe_key(b), (a, b)
