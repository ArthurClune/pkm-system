import asyncio
import json
import time
from concurrent.futures import ThreadPoolExecutor

import pytest
from pkm.assistant import routes
from pkm.assistant.events import SSE_COMMENT, TextDelta


def parse_sse(body: str) -> list[tuple[str, dict]]:
    events = []
    for chunk in body.split("\n\n"):
        if not chunk.strip():
            continue
        if chunk.startswith(":"):
            continue  # comment frame (keepalive); a client ignores these
        lines = chunk.split("\n")
        name = lines[0].removeprefix("event: ")
        data = json.loads(lines[1].removeprefix("data: "))
        events.append((name, data))
    return events


def test_requires_auth(anon_client):
    r = anon_client.post("/api/assistant/conversations", json={})
    assert r.status_code == 401


def test_create_conversation_defaults_to_sonnet(assistant_client):
    r = assistant_client.post("/api/assistant/conversations", json={})
    assert r.status_code == 200
    body = r.json()
    assert body["model"] == "sonnet"
    assert len(body["id"]) == 16


def test_create_conversation_bad_model_400(assistant_client):
    r = assistant_client.post("/api/assistant/conversations", json={"model": "gpt-4o"})
    assert r.status_code == 400


def test_models_endpoint_requires_auth(anon_client):
    assert anon_client.get("/api/assistant/models").status_code == 401


def test_models_endpoint_hides_glm_without_key(assistant_client):
    r = assistant_client.get("/api/assistant/models")
    assert r.status_code == 200
    assert r.json() == {"models": ["sonnet", "opus", "haiku"], "default": "sonnet"}


def test_create_conversation_glm_400_without_key(assistant_client):
    r = assistant_client.post("/api/assistant/conversations", json={"model": "glm"})
    assert r.status_code == 400


def test_models_endpoint_offers_glm_with_key(seeded_config, fake_engine, tmp_path):
    from fastapi.testclient import TestClient
    from pkm.server.app import create_app

    (tmp_path / "zai_key").write_text("zk-test")
    with TestClient(create_app(seeded_config, assistant_engine=fake_engine)) as c:
        assert c.post("/api/login", json={"password": "test-pw"}).status_code == 200
        r = c.get("/api/assistant/models")
        assert r.json() == {"models": ["sonnet", "opus", "haiku", "glm"],
                            "default": "sonnet"}
        # and glm is actually creatable in this state
        assert c.post("/api/assistant/conversations",
                      json={"model": "glm"}).status_code == 200


def test_conversation_cap_evicts_oldest_idle_over_http(assistant_client):
    # pkm-c98s item 1: reaching the cap with idle conversations evicts the
    # least-recently-used one instead of 409ing, so a reload that orphans
    # the client-side conversation id can't lock the user out for 15 min.
    ids = [
        assistant_client.post("/api/assistant/conversations", json={}).json()["id"]
        for _ in range(3)
    ]
    r = assistant_client.post("/api/assistant/conversations", json={})
    assert r.status_code == 200
    assert r.json()["id"] not in ids
    # the oldest conversation is gone server-side
    stale = assistant_client.post(
        f"/api/assistant/conversations/{ids[0]}/messages", json={"text": "hi"}
    )
    assert stale.status_code == 404


def test_conversation_cap_409_when_every_conversation_is_busy(assistant_client):
    ids = [
        assistant_client.post("/api/assistant/conversations", json={}).json()["id"]
        for _ in range(3)
    ]
    service = assistant_client.app.state.assistant
    for cid in ids:
        service._entries[cid].busy = True  # simulate all three mid-turn
    r = assistant_client.post("/api/assistant/conversations", json={})
    assert r.status_code == 409


def test_message_stream_echo(assistant_client):
    cid = assistant_client.post("/api/assistant/conversations", json={}).json()["id"]
    with assistant_client.stream(
        "POST", f"/api/assistant/conversations/{cid}/messages", json={"text": "hi"}
    ) as r:
        assert r.status_code == 200
        assert r.headers["content-type"].startswith("text/event-stream")
        assert r.headers["cache-control"] == "no-cache"
        assert r.headers["x-accel-buffering"] == "no"
        body = "".join(r.iter_text())
    events = parse_sse(body)
    assert events[0] == ("text_delta", {"text": "echo: hi"})
    assert events[-1][0] == "turn_done"


def test_with_keepalive_emits_comment_frames_while_the_turn_is_silent():
    # pkm-mbcc defect 1: a turn can be silent for a long time (a big block to
    # reason about, a confirm parked on the user), and an idle SSE connection
    # is what mobile backgrounding and NAT/proxy timeouts drop.
    async def slow_stream():
        await asyncio.sleep(0.12)
        yield TextDelta(text="hi")

    async def scenario():
        return [frame async for frame in routes._with_keepalive(slow_stream(), 0.03)]

    frames = asyncio.run(scenario())
    assert frames[-1] == 'event: text_delta\ndata: {"text": "hi"}\n\n'
    assert len(frames) >= 3  # at least two keepalives during the 0.12s gap
    assert all(frame == SSE_COMMENT for frame in frames[:-1])


def test_with_keepalive_cancels_the_in_flight_read_when_the_consumer_leaves():
    # a dropped SSE consumer must not orphan the anext() task the keepalive
    # loop is holding across its timeouts
    cancelled = []

    async def parked_stream():
        try:
            await asyncio.Event().wait()  # never set
            yield TextDelta(text="unreachable")  # pragma: no cover
        except asyncio.CancelledError:
            cancelled.append(True)
            raise

    async def scenario():
        gen = routes._with_keepalive(parked_stream(), 0.01)
        frames = []
        async for frame in gen:
            frames.append(frame)
            if len(frames) == 2:
                break
        await gen.aclose()
        await asyncio.sleep(0)  # let the cancellation be delivered
        return frames

    frames = asyncio.run(scenario())
    assert frames == [SSE_COMMENT, SSE_COMMENT]
    assert cancelled == [True]


def test_keepalive_frames_reach_the_wire_and_are_invisible_to_a_client(
    assistant_client, monkeypatch
):
    monkeypatch.setattr(routes, "KEEPALIVE_INTERVAL_S", 0.02)
    cid = assistant_client.post("/api/assistant/conversations", json={}).json()["id"]

    def consume() -> str:
        with assistant_client.stream(
            "POST", f"/api/assistant/conversations/{cid}/messages", json={"text": "please write"}
        ) as r:
            return "".join(r.iter_text())

    with ThreadPoolExecutor(max_workers=1) as ex:
        fut = ex.submit(consume)
        time.sleep(0.25)  # leave the confirm parked long enough to accumulate keepalives
        deadline = time.time() + 5
        while time.time() < deadline and not fut.done():
            assistant_client.post(
                f"/api/assistant/conversations/{cid}/confirm",
                json={"tool_use_id": "fake-confirm-1", "allow": True},
            )
            if fut.done():
                break
            time.sleep(0.05)
        body = fut.result(timeout=5)

    assert SSE_COMMENT in body
    # ...and the turn still reads exactly the same to a client that ignores them
    events = parse_sse(body)
    assert [n for n, _ in events][:2] == ["tool_started", "confirm_request"]
    assert ("text_delta", {"text": "Saved."}) in events


def test_message_unknown_conversation_404(assistant_client):
    r = assistant_client.post("/api/assistant/conversations/nope/messages", json={"text": "hi"})
    assert r.status_code == 404


def test_confirm_roundtrip_over_http(assistant_client):
    cid = assistant_client.post("/api/assistant/conversations", json={}).json()["id"]

    def consume() -> list[tuple[str, dict]]:
        with assistant_client.stream(
            "POST", f"/api/assistant/conversations/{cid}/messages", json={"text": "please write"}
        ) as r:
            return parse_sse("".join(r.iter_text()))

    with ThreadPoolExecutor(max_workers=1) as ex:
        fut = ex.submit(consume)
        # wait until the stream is blocked on the confirm, then answer it
        deadline = time.time() + 5
        while time.time() < deadline:
            resp = assistant_client.post(
                f"/api/assistant/conversations/{cid}/confirm",
                json={"tool_use_id": "fake-confirm-1", "allow": True},
            )
            assert resp.status_code == 200
            if fut.done():
                break
            time.sleep(0.05)
        events = fut.result(timeout=5)

    names = [n for n, _ in events]
    assert "confirm_request" in names
    assert ("text_delta", {"text": "Saved."}) in events


def test_confirm_unknown_conversation_404(assistant_client):
    r = assistant_client.post(
        "/api/assistant/conversations/nope/confirm", json={"tool_use_id": "x", "allow": True}
    )
    assert r.status_code == 404


def test_delete_conversation(assistant_client):
    cid = assistant_client.post("/api/assistant/conversations", json={}).json()["id"]
    assert assistant_client.delete(f"/api/assistant/conversations/{cid}").json() == {"ok": True}
    # idempotent
    assert assistant_client.delete(f"/api/assistant/conversations/{cid}").status_code == 200
    # gone
    r = assistant_client.post(f"/api/assistant/conversations/{cid}/messages", json={"text": "hi"})
    assert r.status_code == 404


def test_close_conversation_via_post_for_sendbeacon(assistant_client):
    # pkm-c98s item 1: navigator.sendBeacon can only POST (no DELETE, no
    # custom body/headers), so the same idempotent close is also reachable
    # by POSTing the conversation's own URL -- used for pagehide cleanup.
    cid = assistant_client.post("/api/assistant/conversations", json={}).json()["id"]
    assert assistant_client.post(f"/api/assistant/conversations/{cid}").json() == {"ok": True}
    # idempotent, and works even when already gone (as sendBeacon fires with
    # no way to check the response)
    assert assistant_client.post(f"/api/assistant/conversations/{cid}").status_code == 200
    r = assistant_client.post(f"/api/assistant/conversations/{cid}/messages", json={"text": "hi"})
    assert r.status_code == 404


class ExplodingConversation:
    healthy = True

    async def send(self, text):
        from pkm.assistant.events import TextDelta

        yield TextDelta(text="partial")
        raise RuntimeError("engine crashed")

    def resolve_confirm(self, tool_use_id, allow):  # pragma: no cover - protocol stub
        pass

    async def close(self):
        pass


class ExplodingEngine:
    async def create_conversation(self, system_prompt, model):
        return ExplodingConversation()


class CloseFailingDescriber:
    async def describe(self, image_bytes: bytes, mime: str) -> str:
        return "unused"

    async def close(self) -> None:
        raise RuntimeError("describe close failed")


def test_app_shutdown_closes_live_conversations(seeded_config):
    from fastapi.testclient import TestClient

    from fake_engine import FakeEngine
    from pkm.server.app import create_app

    engine = FakeEngine()
    with TestClient(create_app(seeded_config, assistant_engine=engine)) as c:
        r = c.post("/api/login", json={"password": "test-pw"})
        assert r.status_code == 200
        c.post("/api/assistant/conversations", json={})
        assert engine.conversations[0].closed is False
    # TestClient's context manager exit runs the app's shutdown lifespan
    assert engine.conversations[0].closed is True


def test_app_shutdown_closes_assistant_when_describer_close_fails(seeded_config):
    from fastapi.testclient import TestClient

    from fake_engine import FakeEngine
    from pkm.describe.service import DescribeService
    from pkm.server.app import create_app

    engine = FakeEngine()
    describer = CloseFailingDescriber()
    service = DescribeService(seeded_config, describer, None)
    app = create_app(
        seeded_config, assistant_engine=engine, describe_service=service)

    with pytest.raises(RuntimeError, match="describe close failed"):
        with TestClient(app) as client:
            client.post("/api/login", json={"password": "test-pw"})
            client.post("/api/assistant/conversations", json={})

    assert engine.conversations[0].closed is True


def test_mid_stream_engine_error_yields_error_event(seeded_config):
    from fastapi.testclient import TestClient

    from pkm.server.app import create_app

    with TestClient(create_app(seeded_config, assistant_engine=ExplodingEngine())) as c:
        r = c.post("/api/login", json={"password": "test-pw"})
        assert r.status_code == 200
        cid = c.post("/api/assistant/conversations", json={}).json()["id"]
        with c.stream("POST", f"/api/assistant/conversations/{cid}/messages", json={"text": "hi"}) as r:
            assert r.status_code == 200
            body = "".join(r.iter_text())
        events = parse_sse(body)
        assert ("text_delta", {"text": "partial"}) in events
        assert events[-1][0] == "error"
        assert "engine crashed" in events[-1][1]["message"]
