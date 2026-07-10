from pkm.server.mime_sniff import resolve_stored_mime, sniff_mime

PNG_HEAD = b"\x89PNG\r\n\x1a\n" + b"rest-of-chunk-data"
JPEG_HEAD = b"\xff\xd8\xff\xe0" + b"rest-of-chunk-data"
GIF87_HEAD = b"GIF87a" + b"rest-of-chunk-data"
GIF89_HEAD = b"GIF89a" + b"rest-of-chunk-data"
WEBP_HEAD = b"RIFF" + b"\x00\x00\x00\x00" + b"WEBP" + b"rest-of-chunk-data"
PDF_HEAD = b"%PDF-1.4\n" + b"rest-of-chunk-data"


def test_sniffs_png():
    assert sniff_mime(PNG_HEAD) == "image/png"


def test_sniffs_jpeg():
    assert sniff_mime(JPEG_HEAD) == "image/jpeg"


def test_sniffs_gif87a():
    assert sniff_mime(GIF87_HEAD) == "image/gif"


def test_sniffs_gif89a():
    assert sniff_mime(GIF89_HEAD) == "image/gif"


def test_sniffs_webp():
    assert sniff_mime(WEBP_HEAD) == "image/webp"


def test_sniffs_pdf():
    assert sniff_mime(PDF_HEAD) == "application/pdf"


def test_sniffs_svg_plain():
    assert sniff_mime(b"<svg onload=alert(1)/>") == "image/svg+xml"


def test_sniffs_svg_with_xml_prolog():
    head = b'<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"></svg>'
    assert sniff_mime(head) == "image/svg+xml"


def test_sniffs_svg_with_leading_whitespace_and_bom():
    head = b"\xef\xbb\xbf  \n<svg></svg>"
    assert sniff_mime(head) == "image/svg+xml"


def test_unrecognized_content_returns_none():
    assert sniff_mime(b"just some plain text, nothing special") is None


def test_short_head_does_not_crash():
    assert sniff_mime(b"") is None
    assert sniff_mime(b"a") is None
    assert sniff_mime(b"RI") is None


def test_office_zip_signature_not_confidently_claimed():
    # docx/xlsx/pptx are ZIP containers; we don't attempt to distinguish
    # them from a generic ZIP, so they fall through to the declared type.
    assert sniff_mime(b"PK\x03\x04" + b"rest-of-chunk-data") is None


def test_resolve_prefers_sniffed_when_known():
    assert resolve_stored_mime("application/pdf", "image/png") == "image/png"


def test_resolve_falls_back_to_declared_when_unsniffed():
    assert resolve_stored_mime("text/plain", None) == "text/plain"
