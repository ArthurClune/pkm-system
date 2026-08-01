"""CleanupFileResponse (pkm-13ty): a FileResponse whose cleanup callback
must run even when the response never reaches a completed send, unlike
stock FileResponse's `background` task, which Starlette only awaits
after `__call__` returns *without* raising.

Under this project's actual ASGI server (uvicorn 0.49.0), an ordinary
client disconnect does NOT hit that gap: uvicorn's `send()` silently
no-ops once the connection is marked disconnected rather than raising,
so the send loop still runs to completion and stock `background` still
fires. What genuinely needs `CleanupFileResponse`: a missing/unreadable
file (`FileResponse.__call__` raises `RuntimeError` from its own
`os.stat` before reaching the `background` line) and, as
defense-in-depth, an ASGI server that -- unlike uvicorn -- surfaces a
dropped connection as a `send()` exception rather than a no-op (nothing
in the ASGI spec guarantees uvicorn's no-op behavior)."""
import pytest

from pkm.server.tempfile_response import CleanupFileResponse


class _Cleanup:
    def __init__(self):
        self.calls = 0

    async def __call__(self) -> None:
        self.calls += 1


async def _noop_receive():
    return {"type": "http.disconnect"}


def _scope():
    return {"type": "http", "method": "GET", "headers": []}


@pytest.mark.anyio
async def test_cleanup_runs_after_a_successful_send(tmp_path):
    path = tmp_path / "a.zip"
    path.write_bytes(b"zip-bytes")
    cleanup = _Cleanup()
    sent = []

    async def send(message):
        sent.append(message)

    resp = CleanupFileResponse(path, media_type="application/zip",
                               filename="a.zip", cleanup=cleanup)
    await resp(_scope(), _noop_receive, send)

    assert cleanup.calls == 1
    bodies = b"".join(m["body"] for m in sent if m["type"] == "http.response.body")
    assert bodies == b"zip-bytes"


@pytest.mark.anyio
async def test_cleanup_runs_if_send_itself_raises_mid_transfer(tmp_path):
    # Not a model of uvicorn (its send() no-ops on a dropped connection
    # rather than raising -- see the module docstring). This covers
    # defense-in-depth for an ASGI server that *does* surface a broken
    # connection as a send() exception instead.
    path = tmp_path / "a.zip"
    path.write_bytes(b"zip-bytes")
    cleanup = _Cleanup()
    call_count = 0

    async def send(message):
        nonlocal call_count
        call_count += 1
        if message["type"] == "http.response.body":
            raise OSError("send() raised instead of no-opping")

    resp = CleanupFileResponse(path, media_type="application/zip",
                               filename="a.zip", cleanup=cleanup)
    with pytest.raises(OSError, match="send\\(\\) raised instead of no-opping"):
        await resp(_scope(), _noop_receive, send)

    assert cleanup.calls == 1


@pytest.mark.anyio
async def test_cleanup_runs_even_if_the_file_is_missing(tmp_path):
    # Stat fails before any bytes are sent -- cleanup must still fire so
    # a route that built (or half-built) a temp dir doesn't leak it.
    path = tmp_path / "missing.zip"
    cleanup = _Cleanup()

    async def send(message):
        pass

    resp = CleanupFileResponse(path, media_type="application/zip",
                               filename="missing.zip", cleanup=cleanup)
    with pytest.raises(RuntimeError):
        await resp(_scope(), _noop_receive, send)

    assert cleanup.calls == 1


@pytest.fixture
def anyio_backend():
    return "asyncio"
