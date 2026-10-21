# pattern: Imperative Shell
"""The `{name:wholepath}` route parameter, registered with Starlette on
import. A route that takes a title or a file path in its URL uses it, so
the handler sees every character the client sent."""
from __future__ import annotations

from starlette.convertors import Convertor, register_url_convertor


class WholePathConvertor(Convertor[str]):
    """Starlette's `path` convertor matches `.*` under a trailing `$`,
    which stops before a final newline: `/api/local/a%0A` would reach the
    handler as `a`, and `/api/page/Foo%20%0A` as `Foo ` with the newline
    that made the space foldable gone. A newline inside the value matched
    no route at all. DOTALL hands the handler the whole decoded value, so
    the handler's own parser (`clean_relative`, `read_title`) judges it."""
    regex = "(?s:.*)"

    def convert(self, value: str) -> str:
        return value

    def to_string(self, value: str) -> str:
        return value


register_url_convertor("wholepath", WholePathConvertor())
