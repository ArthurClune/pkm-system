# pattern: Functional Core
"""Well-formed text: what the write contract carries is a sequence of
Unicode scalar values, never a lone surrogate.

A browser's JSON.stringify escapes a lone surrogate as `\\udXXX` rather
than failing, and Python's json decodes the escape back into a str that
SQLite (strict UTF-8) refuses to bind. The web stores and hashes such a
text through TextEncoder, which reads each lone surrogate as U+FFFD, so
the server normalises to that same form at the boundary instead of
rejecting: a rejected batch would sit in the outbox, and the edit the
person typed would be lost rather than kept with one odd character.

`well_formed` is Python's twin of the web's `wellFormed`
(web/src/replica/wellFormed.ts), and of `String.prototype.toWellFormed`."""
from __future__ import annotations

import re
from re import Match

from pydantic import model_validator

from pkm.contracts.strict import StrictModel

_ANY_SURROGATE = re.compile("[\ud800-\udfff]")
# A high/low pair first, so the alternation never splits one: Python holds
# a pair as two code points only when a str was built by hand, but the web
# sees those two code units as one astral character, so they must stay one.
_SURROGATE_RUN = re.compile("[\ud800-\udbff][\udc00-\udfff]|[\ud800-\udfff]")


def _replace(match: Match[str]) -> str:
    unit = match.group()
    if len(unit) == 2:
        return unit.encode("utf-16-le", "surrogatepass").decode("utf-16-le")
    return "\ufffd"


def well_formed(text: str) -> str:
    """`text` with each lone surrogate replaced by U+FFFD (and a hand-built
    high/low pair joined into its astral character). Returns `text` itself
    when it holds no surrogate, which is every text but a hostile one."""
    if _ANY_SURROGATE.search(text) is None:
        return text
    return _SURROGATE_RUN.sub(_replace, text)


class WellFormedModel(StrictModel):
    """A contract model whose every str field is well-formed once
    validated, whatever the client sent: the base of the op models, so a
    field added later is covered without anyone remembering to. Only the
    model's own top-level values are visited; a field holding a list of
    models is covered by each model's own validation.

    It runs on the raw input, before pydantic's field validation: a field
    with a length constraint hands its str to pydantic-core as UTF-8,
    which refuses a lone surrogate with a 422 whose echo of the input then
    fails to encode as JSON, so the request still ends in a 500. A model
    validator rather than a field one, because pydantic allows no
    before-validator on a union's discriminator field (`op`)."""

    @model_validator(mode="before")
    @classmethod
    def _well_formed_strings(cls, data: object) -> object:
        if not isinstance(data, dict):
            return data
        return {key: well_formed(value) if isinstance(value, str) else value
                for key, value in data.items()}
