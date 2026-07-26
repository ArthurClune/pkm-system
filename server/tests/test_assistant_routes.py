import json
import time
from concurrent.futures import ThreadPoolExecutor


def parse_sse(body: str) -> list[tuple[str, dict]]:
    events = []
    for chunk in body.split("\n\n"):
        if not chunk.strip():
            continue
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


def test_conversation_cap_409(assistant_client):
    for _ in range(3):
        assert assistant_client.post("/api/assistant/conversations", json={}).status_code == 200
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


class ExplodingConversation:
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


def test_assistant_unconfigured_503(client):
    # the standard `client` fixture builds create_app() without an engine
    r = client.post("/api/assistant/conversations", json={})
    assert r.status_code == 503
