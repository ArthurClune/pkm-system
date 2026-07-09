import socket

import pytest

from pkm.server.run import bind_sockets


def test_bind_sockets_binds_each_host():
    socks = bind_sockets(["127.0.0.1"], 0)
    try:
        assert len(socks) == 1
        host, port = socks[0].getsockname()
        assert host == "127.0.0.1" and port > 0
    finally:
        for s in socks:
            s.close()


def test_bind_failure_releases_partial_binds():
    tmp = socket.socket()
    tmp.bind(("127.0.0.1", 0))
    port = tmp.getsockname()[1]
    tmp.close()
    # second bind to the same host:port collides; the first must be released
    with pytest.raises(OSError):
        bind_sockets(["127.0.0.1", "127.0.0.1"], port)
    s = socket.socket()
    s.bind(("127.0.0.1", port))  # would EADDRINUSE if the first bind leaked
    s.close()
