"""ImageDescriber test double (same convention as fake_engine.py)."""
from pkm.describe.service import DescribeError

PNG = b"\x89PNG\r\n\x1a\n" + b"fakepixels"


class FakeDescriber:
    def __init__(self, text: str = "a bar chart of monthly revenue",
                 error: str | None = None):
        self.text = text
        self.error = error
        self.calls: list[str] = []

    async def describe(self, image_bytes: bytes, mime: str) -> str:
        self.calls.append(mime)
        if self.error is not None:
            raise DescribeError(self.error)
        return self.text
