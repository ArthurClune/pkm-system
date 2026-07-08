# pattern: Functional Core
"""Password hashing and session-token signing. All comparisons constant-time."""
from __future__ import annotations

import hashlib
import hmac


def hash_password(password: str, salt: bytes) -> str:
    return hashlib.scrypt(password.encode("utf-8"), salt=salt,
                          n=2**14, r=8, p=1).hex()


def verify_password(password: str, salt: bytes, expected_hex: str) -> bool:
    return hmac.compare_digest(hash_password(password, salt), expected_hex)


def sign_session(secret: bytes, issued_at_ms: int) -> str:
    payload = f"v1.{issued_at_ms}"
    sig = hmac.new(secret, payload.encode("ascii"), hashlib.sha256).hexdigest()
    return f"{payload}.{sig}"


YEAR_MS = 365 * 24 * 3600 * 1000
SKEW_MS = 5 * 60 * 1000


def verify_session(secret: bytes, token: str, now_ms: int,
                   max_age_ms: int = YEAR_MS) -> bool:
    parts = token.split(".")
    if (len(parts) != 3 or parts[0] != "v1"
            or not parts[1].isascii() or not parts[1].isdigit()):
        return False
    payload = f"{parts[0]}.{parts[1]}"
    expected = hmac.new(secret, payload.encode("ascii"), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, parts[2]):
        return False
    issued = int(parts[1])
    return issued <= now_ms + SKEW_MS and now_ms - issued <= max_age_ms
