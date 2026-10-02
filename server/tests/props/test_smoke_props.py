import sqlite3

import pytest
from hypothesis import given, settings, strategies as st

from props.harness import examples, fresh_app

pytestmark = pytest.mark.proptest


@settings(max_examples=examples("smoke"))
@given(st.integers(min_value=0, max_value=3))
def test_each_example_gets_its_own_db(template_db, n):
    app = fresh_app(template_db)
    try:
        r = app.client.post("/api/ops", json={"client_id": "p", "batch_id": f"smoke_{n:04d}xx",
            "ops": [{"op": "create_page", "page_title": f"Smoke {n}"}]})
        assert r.status_code == 200
        con = sqlite3.connect(app.config.db_path)
        try:
            titles = [row[0] for row in con.execute("SELECT title FROM pages").fetchall()]
        finally:
            con.close()
        assert sum(t.startswith("Smoke ") for t in titles) == 1   # no leakage from earlier examples
    finally:
        app.close()
