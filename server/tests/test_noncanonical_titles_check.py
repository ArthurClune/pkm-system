"""The startup check: a stored title the live rule no longer leaves
unchanged is unreachable by key, so the server names it in one ERROR at
startup and keeps serving; the remedy is the audited migration."""
import logging

from fastapi.testclient import TestClient

from conftest import TEST_PASSWORD
from pkm.database import connect
from pkm.server.app import create_app
from pkm.server.title_migration import report_noncanonical_titles


def _set_flag(db_path, value: str) -> None:
    con = connect(db_path)
    con.execute(
        "UPDATE sync_meta SET value=?"
        " WHERE key='plain_space_title_canonicalization'", (value,))
    con.commit()
    con.close()


def _insert_page(db_path, row_id: int, title_text: str) -> None:
    con = connect(db_path)
    con.execute("INSERT INTO pages(id, title) VALUES (?, ?)",
                (row_id, title_text))
    con.commit()
    con.close()


def _insert_sidebar(db_path, title_text: str) -> None:
    con = connect(db_path)
    con.execute(
        "INSERT INTO sidebar_entries(id, title, order_idx) VALUES (90, ?, 0)",
        (title_text,))
    con.commit()
    con.close()


def _title_records(caplog) -> list[logging.LogRecord]:
    return [record for record in caplog.records
            if record.name == "pkm.titles"]


def test_startup_logs_noncanonical_titles(seeded_config, caplog):
    _set_flag(seeded_config.db_path, "1")
    _insert_page(seeded_config.db_path, 90, "A B")
    _insert_sidebar(seeded_config.db_path, "X  Y")

    with caplog.at_level(logging.INFO, logger="pkm.titles"):
        with TestClient(create_app(seeded_config)) as client:
            login = client.post("/api/login",
                                json={"password": TEST_PASSWORD})
            assert login.status_code == 200
            assert client.get("/api/page/Paper").status_code == 200
            assert client.get("/api/sidebar").status_code == 200

    [record] = _title_records(caplog)
    assert record.levelno == logging.ERROR
    message = record.getMessage()
    assert "2" in message
    assert repr("A B") in message
    assert repr("X  Y") in message
    assert "pkm migrate-titles" in message


def test_startup_is_silent_on_a_canonical_database(seeded_config, caplog):
    _set_flag(seeded_config.db_path, "1")

    with caplog.at_level(logging.INFO, logger="pkm.titles"):
        with TestClient(create_app(seeded_config)):
            pass

    assert _title_records(caplog) == []


def test_inactive_database_keeps_legacy_padding_quiet(seeded_config, caplog):
    """Single-space padding is a fixed point of the inactive rule, so it
    still resolves and is not reported; a double space folds under either
    flag, so it is."""
    _insert_page(seeded_config.db_path, 90, " Padded ")

    with caplog.at_level(logging.INFO, logger="pkm.titles"):
        assert report_noncanonical_titles(seeded_config.db_path) == 0
    assert _title_records(caplog) == []

    _insert_page(seeded_config.db_path, 91, "Two  Spaces")
    with caplog.at_level(logging.INFO, logger="pkm.titles"):
        assert report_noncanonical_titles(seeded_config.db_path) == 1
    [record] = _title_records(caplog)
    assert repr("Two  Spaces") in record.getMessage()
    assert repr(" Padded ") not in record.getMessage()


def test_report_bounds_the_logged_sample(seeded_config, caplog):
    """Every offending title is counted, but the message names a bounded,
    sorted sample, so a large backlog cannot flood the log."""
    _set_flag(seeded_config.db_path, "1")
    for n in range(25):
        _insert_page(seeded_config.db_path, 100 + n, f"T{n:02d}  x")

    with caplog.at_level(logging.INFO, logger="pkm.titles"):
        assert report_noncanonical_titles(seeded_config.db_path) == 25

    [record] = _title_records(caplog)
    message = record.getMessage()
    assert "25" in message
    named = [n for n in range(25) if repr(f"T{n:02d}  x") in message]
    assert named == list(range(20))
