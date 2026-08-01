"""CleanupFileResponse (pkm-13ty): a FileResponse whose cleanup callback
must run even when sending is interrupted, unlike stock FileResponse's
`background` task, which stock Starlette only awaits after `_handle_simple`'s
send loop returns *without* raising -- so a client disconnect mid-download
would otherwise leak the backing temp file/directory forever."""
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
async def test_cleanup_runs_even_if_send_raises_mid_transfer(tmp_path):
    # Simulates a client disconnecting partway through the download: the
    # ASGI send() raises once the peer has gone away.
    path = tmp_path / "a.zip"
    path.write_bytes(b"zip-bytes")
    cleanup = _Cleanup()
    call_count = 0

    async def send(message):
        nonlocal call_count
        call_count += 1
        if message["type"] == "http.response.body":
            raise OSError("client disconnected")

    resp = CleanupFileResponse(path, media_type="application/zip",
                               filename="a.zip", cleanup=cleanup)
    with pytest.raises(OSError, match="client disconnected"):
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
