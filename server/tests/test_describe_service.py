import asyncio

import pytest
from fake_describer import PNG, BlockingDescriber, FakeDescriber

from pkm.describe.service import DescribeService
from pkm.server.db import open_db


def _insert_asset(config, sha, mime="image/png", size=None,
                  content=PNG, description=None, error=None):
    (config.assets_dir / sha[:2]).mkdir(parents=True, exist_ok=True)
    (config.assets_dir / sha[:2] / sha).write_bytes(content)
    con = open_db(config.db_path)
    con.execute(
        "INSERT INTO assets(sha256, filename, mime, size, created_at,"
        " description, describe_error) VALUES (?,?,?,?,?,?,?)",
        (sha, "f.png", mime, size if size is not None else len(content),
         1000, description, error))
    con.commit()
    con.close()


def _asset_row(config, sha):
    con = open_db(config.db_path)
    row = con.execute("SELECT description, described_at, describe_error"
                      " FROM assets WHERE sha256 = ?", (sha,)).fetchone()
    con.close()
    return row


SHA_A = "aa" * 32
SHA_B = "bb" * 32


async def _run(service, *shas_mimes):
    service.start()
    for sha, mime, size in shas_mimes:
        service.maybe_enqueue(sha, mime, size)
    await asyncio.wait_for(service.drain(), timeout=5)
    await service.close()


def test_worker_writes_description(seeded_config):
    fake = FakeDescriber()
    service = DescribeService(seeded_config, fake, None)
    _insert_asset(seeded_config, SHA_A)
    asyncio.run(_run(service, (SHA_A, "image/png", len(PNG))))
    row = _asset_row(seeded_config, SHA_A)
    assert row["description"] == "a bar chart of monthly revenue"
    assert row["described_at"] is not None
    assert row["describe_error"] is None
    assert fake.calls == ["image/png"]


def test_worker_records_error(seeded_config):
    service = DescribeService(seeded_config, FakeDescriber(error="openai http 429"), None)
    _insert_asset(seeded_config, SHA_A)
    asyncio.run(_run(service, (SHA_A, "image/png", len(PNG))))
    row = _asset_row(seeded_config, SHA_A)
    assert row["description"] is None
    assert row["describe_error"] == "openai http 429"


def test_worker_skips_already_described(seeded_config):
    fake = FakeDescriber()
    service = DescribeService(seeded_config, fake, None)
    _insert_asset(seeded_config, SHA_A, description="already done")
    asyncio.run(_run(service, (SHA_A, "image/png", len(PNG))))
    assert fake.calls == []
    assert _asset_row(seeded_config, SHA_A)["description"] == "already done"


def test_worker_records_too_large(seeded_config):
    fake = FakeDescriber()
    service = DescribeService(seeded_config, fake, None)
    _insert_asset(seeded_config, SHA_A, size=16 * 1024 * 1024)
    asyncio.run(_run(service, (SHA_A, "image/png", 16 * 1024 * 1024)))
    row = _asset_row(seeded_config, SHA_A)
    assert fake.calls == []
    assert row["describe_error"] == "too large to describe"


def test_worker_records_missing_file(seeded_config):
    fake = FakeDescriber()
    service = DescribeService(seeded_config, fake, None)
    con = open_db(seeded_config.db_path)  # row without a file on disk
    con.execute("INSERT INTO assets(sha256, filename, mime, size, created_at)"
                " VALUES (?,?,?,?,?)", (SHA_A, "f.png", "image/png", 10, 1000))
    con.commit()
    con.close()
    asyncio.run(_run(service, (SHA_A, "image/png", 10)))
    assert _asset_row(seeded_config, SHA_A)["describe_error"] == "file missing"


def test_maybe_enqueue_ignores_ineligible_and_disabled(seeded_config):
    service = DescribeService(seeded_config, FakeDescriber(), None)
    service.maybe_enqueue(SHA_A, "text/csv", 10)      # ineligible mime
    assert service._queue.qsize() == 0
    disabled = DescribeService(seeded_config, None, "OPENAI_API_KEY is not set")
    assert disabled.enabled is False
    disabled.maybe_enqueue(SHA_A, "image/png", 10)    # disabled: no-op
    assert disabled._queue.qsize() == 0
    disabled.start()                                   # no worker when disabled
    assert disabled._task is None


def test_close_closes_owned_describer_once(seeded_config):
    fake = FakeDescriber()
    service = DescribeService(seeded_config, fake, None)

    async def run():
        service.start()
        await service.close()
        await service.close()

    asyncio.run(run())
    assert fake.close_calls == 1


def test_close_cancels_worker_before_closing_describer(seeded_config):
    fake = BlockingDescriber()
    service = DescribeService(seeded_config, fake, None)
    _insert_asset(seeded_config, SHA_A)

    async def run():
        service.start()
        service.maybe_enqueue(SHA_A, "image/png", len(PNG))
        await asyncio.to_thread(fake.started.wait, 5)
        await service.close()

    asyncio.run(run())
    assert fake.events == ["describe-finished", "closed"]
    assert fake.close_calls == 1


def test_close_disabled_service_is_idempotent(seeded_config):
    service = DescribeService(
        seeded_config, None, "OPENAI_API_KEY is not set")
    asyncio.run(service.close())
    asyncio.run(service.close())


def test_start_rejects_reuse_after_close(seeded_config):
    service = DescribeService(seeded_config, FakeDescriber(), None)
    asyncio.run(service.close())
    with pytest.raises(RuntimeError, match="describe service is closed"):
        service.start()


def test_scan_enqueues_undescribed_and_force_retries(seeded_config):
    fake = FakeDescriber(error="openai http 429")
    service = DescribeService(seeded_config, fake, None)
    _insert_asset(seeded_config, SHA_A)                      # pending
    _insert_asset(seeded_config, SHA_B, error="openai http 500")  # failed
    con = open_db(seeded_config.db_path)
    assert service.scan(con) == 1            # pending only
    # Let SHA_A's ordinary attempt run to completion (and fail) before
    # force-rescanning, so it's no longer "active" and the dedup guard
    # doesn't mask the force-retry path under test (pkm-1wv1).
    asyncio.run(_run(service))
    assert service.scan(con, force=True) == 2  # failed too
    con.close()


def test_scan_does_not_requeue_a_sha_already_active(seeded_config):
    """Two scans before the worker drains the first pending sha must not
    double-queue it -- this is the "repeated scan" duplication the bean
    describes (pkm-1wv1)."""
    service = DescribeService(seeded_config, FakeDescriber(), None)
    _insert_asset(seeded_config, SHA_A)
    con = open_db(seeded_config.db_path)
    assert service.scan(con) == 1
    assert service.scan(con, force=True) == 0   # SHA_A already active: nothing new
    assert service._queue.qsize() == 1
    con.close()


def test_maybe_enqueue_dedupes_while_in_flight(seeded_config):
    """Two maybe_enqueue calls for the same sha while the first attempt is
    genuinely in flight must not trigger a second describe call -- this is
    the "duplicate upload" duplication the bean describes (pkm-1wv1)."""
    fake = BlockingDescriber(error="openai http 429")
    service = DescribeService(seeded_config, fake, None)
    _insert_asset(seeded_config, SHA_A)

    async def run():
        service.start()
        service.maybe_enqueue(SHA_A, "image/png", len(PNG))
        await asyncio.to_thread(fake.started.wait, 5)  # now genuinely in-flight
        service.maybe_enqueue(SHA_A, "image/png", len(PNG))  # duplicate
        assert service._queue.qsize() == 0  # not re-queued while active
        fake.release.set()
        await asyncio.wait_for(service.drain(), timeout=5)
        await service.close()

    asyncio.run(run())
    assert fake.calls == ["image/png"]  # describer invoked exactly once
    row = _asset_row(seeded_config, SHA_A)
    assert row["describe_error"] == "openai http 429"

    # finally-cleanup: once the attempt has finished, the sha is no longer
    # blocked, so a later retry is allowed through again.
    service.maybe_enqueue(SHA_A, "image/png", len(PNG))
    assert service._queue.qsize() == 1


def test_scan_disabled_returns_zero(seeded_config):
    service = DescribeService(seeded_config, None, "OPENAI_API_KEY is not set")
    con = open_db(seeded_config.db_path)
    assert service.scan(con) == 0
    con.close()


def test_worker_survives_unexpected_exception(seeded_config):
    class ExplodingDescriber:
        async def describe(self, image_bytes: bytes, mime: str) -> str:
            raise RuntimeError("boom")

        async def close(self) -> None:
            pass

    service = DescribeService(seeded_config, ExplodingDescriber(), None)
    _insert_asset(seeded_config, SHA_A)
    _insert_asset(seeded_config, SHA_B)

    async def run():
        service.start()
        service.maybe_enqueue(SHA_A, "image/png", len(PNG))
        service.maybe_enqueue(SHA_B, "image/png", len(PNG))
        await asyncio.wait_for(service.drain(), timeout=5)
        assert service._task is not None and not service._task.done()  # worker survived the crash
        await service.close()

    asyncio.run(run())
