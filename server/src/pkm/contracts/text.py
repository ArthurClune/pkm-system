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


type _Container = dict[object, object] | list[object]


def well_formed_tree(value: object) -> object:
    """`value` with `well_formed` applied to every str in it, at any depth:
    a dict's keys and values and a list's items, each container copied.
    Anything else is returned as it is. The walk keeps its own stack
    rather than recursing, so a JSON body nested deeper than Python's
    recursion limit (json.loads accepts one) is walked whole."""
    stack: list[tuple[object, _Container]] = []
    root = _copied(value, stack)
    while stack:
        source, target = stack.pop()
        if isinstance(source, dict) and isinstance(target, dict):
            for key, item in source.items():
                fixed = well_formed(key) if isinstance(key, str) else key
                target[fixed] = _copied(item, stack)
        elif isinstance(source, list) and isinstance(target, list):
            for index, item in enumerate(source):
                target[index] = _copied(item, stack)
    return root


def _copied(value: object, stack: list[tuple[object, _Container]]) -> object:
    """A str made well-formed; an empty copy of a container, queued on
    `stack` to be filled; anything else as it is."""
    if isinstance(value, str):
        return well_formed(value)
    copy: _Container
    if isinstance(value, dict):
        copy = {}
    elif isinstance(value, list):
        copy = [None] * len(value)
    else:
        return value
    stack.append((value, copy))
    return copy


class WellFormedModel(StrictModel):
    """A contract model whose every str is well-formed once validated,
    whatever the client sent: the base of the op models and of every
    request body model, so a field added later is covered without anyone
    remembering to. The whole input is walked, nested dicts and lists
    included, so a free-form field (a `dict[str, Any]` report, a list of
    titles) is covered as well as the model's own str fields.

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
        return well_formed_tree(data)
