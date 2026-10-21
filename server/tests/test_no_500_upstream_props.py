"""Whatever an upstream answers, the app answers cleanly. The GoodLinks
routes meet any status and any body from GoodLinks (arbitrary JSON, a
link-shaped object with hostile fields, bytes that are not JSON or not
UTF-8, JSON nested past the recursion limit, a dropped connection) with a
503 or a clean payload, never a 500. The image describer turns any
answer from OpenAI into a well-formed description or a DescribeError,
never another exception (which would leave the asset pending forever)."""
import asyncio
import itertools
import json
from collections.abc import Iterator

import httpx2
import pytest
from asgi_harness import encode_segment, open_harness
from hostile import event, hostile_text, json_value, value_labels
from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st

from pkm.describe.core import MAX_DESCRIPTION_CHARS
from pkm.describe.openai_client import OpenAIDescriber
from pkm.describe.service import DescribeError
from pkm.server.goodlinks_gateway import GoodlinksGateway

_ID = "e4966bb2483b5c78f658398c0ae7b03f"
_hex_id = st.text(alphabet="0123456789abcdef", min_size=32, max_size=32)

# A link GoodLinks could send, its fields hostile; and one with any shape.
_good_link = st.fixed_dictionaries(
    {"id": st.one_of(st.just(_ID), _hex_id),
     "url": st.one_of(st.just("https://a.example/p"), hostile_text),
     "title": hostile_text},
    optional={"addedAt": st.one_of(st.just("2026-09-23T10:00:00Z"),
                                   hostile_text, json_value),
              "error": hostile_text})
_any_link = st.fixed_dictionaries({}, optional={
    "id": st.one_of(st.just(_ID), _hex_id, json_value),
    "url": st.one_of(st.just("https://a.example/p"), hostile_text,
                     json_value),
    "title": st.one_of(hostile_text, json_value),
    "addedAt": json_value,
    "error": st.one_of(hostile_text, json_value),
})
_completion = st.fixed_dictionaries({"choices": st.lists(
    st.fixed_dictionaries({"message": st.fixed_dictionaries(
        {"content": hostile_text})}), min_size=1, max_size=2)})
_any_completion = st.fixed_dictionaries({}, optional={
    "choices": st.one_of(json_value, st.lists(st.fixed_dictionaries(
        {}, optional={"message": st.one_of(json_value, st.fixed_dictionaries(
            {}, optional={"content": st.one_of(hostile_text, json_value)}))}),
        max_size=2))})

_raw_bodies = st.one_of(
    st.binary(max_size=24),
    st.just(b"\xff\xfe\x00{"),
    st.just(b'"\\ud800"'),
    # Deeper than json.loads can read: it raises RecursionError.
    st.just(b"[" * 100_000 + b"]" * 100_000),
)


def _json_body(value: object) -> bytes:
    # The default ASCII escapes: a lone surrogate travels as \udXXX.
    return json.dumps(value).encode()


# Drawn by index, since one_of collapses repeated strategies: a body an
# upstream could send in half the draws, anything in the rest.
_BODIES: list[st.SearchStrategy[bytes]] = [
    _good_link.map(_json_body),
    st.fixed_dictionaries({"data": st.lists(_good_link, max_size=2),
                           "hasMore": st.booleans()}).map(_json_body),
    _completion.map(_json_body),
    _good_link.map(_json_body),
    _completion.map(_json_body),
    _any_link.map(_json_body),
    st.fixed_dictionaries({"data": st.one_of(st.lists(_any_link, max_size=3),
                                             json_value)},
                          optional={"hasMore": json_value}).map(_json_body),
    _any_completion.map(_json_body),
    json_value.map(_json_body),
    _raw_bodies,
]
_bodies = st.integers(0, len(_BODIES) - 1).flatmap(lambda i: _BODIES[i])
_STATUSES = [200, 200, 200, 200, 200, 201, 204, 301, 400, 401, 403, 404, 409,
             422, 429, 500, 502, 503]
_statuses = st.integers(0, len(_STATUSES) - 1).map(_STATUSES.__getitem__)


# A response (status, body, content type), or a transport error to raise.
type Answer = tuple[int, bytes, str] | type[httpx2.TransportError]


@st.composite
def answers(draw) -> list[Answer]:
    """What the upstream says to each request in turn."""
    out: list[Answer] = []
    for _ in range(draw(st.integers(1, 6))):
        if draw(st.integers(0, 9)) == 4:
            out.append(draw(st.sampled_from(
                [httpx2.ConnectError, httpx2.ReadTimeout,
                 httpx2.RemoteProtocolError])))
            continue
        status = draw(_statuses)
        body = draw(_bodies)
        kind = draw(st.sampled_from(["application/json", "text/html", ""]))
        out.append((status, body, kind))
    return out


class Scripted:
    """An httpx2 MockTransport handler that plays `answers` in a loop."""

    def __init__(self) -> None:
        self._next: Iterator[Answer] = iter(())

    def play(self, script: list[Answer]) -> None:
        self._next = itertools.cycle(script)

    def __call__(self, request: httpx2.Request) -> httpx2.Response:
        answer = next(self._next)
        if not isinstance(answer, tuple):
            event(f"upstream: {answer.__name__}")
            raise answer("scripted", request=request)
        status, body, kind = answer
        event(f"upstream: {status // 100}xx")
        headers = {"content-type": kind} if kind else {}
        return httpx2.Response(status, content=body, headers=headers)


_SUPPRESSED = [HealthCheck.function_scoped_fixture, HealthCheck.too_slow,
               HealthCheck.data_too_large]


@pytest.fixture(scope="module")
def goodlinks(tmp_path_factory):
    scripted = Scripted()
    http = httpx2.Client(transport=httpx2.MockTransport(scripted),
                         base_url="http://goodlinks.test/api/v1")
    gateway = GoodlinksGateway("http://goodlinks.test/api/v1", "tok",
                               http=http)
    with open_harness(tmp_path_factory.mktemp("goodlinks"),
                      goodlinks_gateway=gateway) as harness:
        # A block holding two GoodLinks hrefs, so the check route asks.
        harness.template.execute(
            "INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text,"
            " collapsed) VALUES ('uid_gl01', 1, NULL, 9, ?, 0)",
            (f"read /api/goodlinks/{_ID} and [x](/api/goodlinks/{'a' * 32})",))
        harness.template.commit()
        yield harness, scripted


@st.composite
def goodlinks_requests(draw) -> tuple[str, str, dict]:
    kind = draw(st.sampled_from(["resolve", "article", "check"]))
    if kind == "resolve":
        body = {"url": draw(st.one_of(st.just("https://a.example/p"),
                                      hostile_text)),
                "save": draw(st.booleans())}
        for label in sorted(value_labels(body)):
            event(f"resolve url: {label}")
        return "POST", "/api/goodlinks/resolve", {
            "content": json.dumps(body),
            "headers": {"content-type": "application/json"}}
    if kind == "article":
        link_id = draw(st.one_of(st.just(_ID), _hex_id))
        return "GET", f"/api/goodlinks/{encode_segment(link_id)}", {}
    return "GET", "/api/goodlinks/check", {}


@settings(max_examples=300, deadline=None, suppress_health_check=_SUPPRESSED)
@given(script=answers(), request=goodlinks_requests())
def test_goodlinks_routes_answer_any_upstream_cleanly(goodlinks, script,
                                                      request):
    harness, scripted = goodlinks
    harness.reset()
    scripted.play(script)
    method, url, kwargs = request
    response = harness.send(method, url, **kwargs)
    route = url.split("/")[3]
    event(f"{method} {'article' if len(route) == 32 else route}"
          f" -> {response.status_code}")
    status = response.status_code
    assert status < 500 or status == 503, (url, response.text[:300])
    if status < 300:
        body = response.json()
        assert "�" in response.text or response.text.encode()
        assert isinstance(body, dict)


def _describe(script: list[Answer]) -> str:
    scripted = Scripted()
    scripted.play(script)
    client = httpx2.AsyncClient(transport=httpx2.MockTransport(scripted))
    describer = OpenAIDescriber("key", "model", http=client)

    async def run() -> str:
        try:
            return await describer.describe(b"\x89PNG", "image/png")
        finally:
            await describer.close()

    return asyncio.run(run())


# Half the scripts are one completion OpenAI could send, its content
# hostile; the rest are any answers at all.
_one_completion: st.SearchStrategy[list[Answer]] = _completion.map(
    lambda c: [(200, _json_body(c), "application/json")])


@settings(max_examples=250, deadline=None, suppress_health_check=_SUPPRESSED)
@given(script=st.integers(0, 1).flatmap(
    lambda i: _one_completion if i else answers()))
def test_the_describer_turns_any_answer_into_a_description_or_an_error(
        script):
    try:
        text = _describe(script)
    except DescribeError as exc:
        event("describe: DescribeError")
        assert str(exc)
        return
    event("describe: description")
    text.encode()
    assert text and text == text.strip()
    assert len(text) <= MAX_DESCRIPTION_CHARS
