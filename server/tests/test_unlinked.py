from pkm.server.fts import escape_fts_query, phrase_query


def test_escape_fts_query():
    assert escape_fts_query("machine learn") == '"machine" "learn"*'
    assert escape_fts_query('say "hi"') == '"say" "\"\"hi\"\""*'
    assert escape_fts_query("  ") == '""'


def test_phrase_query():
    assert phrase_query("Machine Learning") == '"Machine Learning"'


def test_unlinked_endpoint(client):
    r = client.get("/api/unlinked", params={"title": "Machine Learning"})
    assert r.status_code == 200
    body = r.json()
    assert body["total"] == 1
    [group] = body["groups"]
    assert group["page_title"] == "AI"
    assert [i["uid"] for i in group["items"]] == ["uid_b6"]
    # uid_b4 links [[Machine Learning]] so it is NOT unlinked


def test_unlinked_missing_page_404(client):
    assert client.get("/api/unlinked",
                      params={"title": "No Such Page"}).status_code == 404


def test_unlinked_preserves_inactive_padded_exact_reads(client):
    assert client.get("/api/unlinked",
                      params={"title": " Machine Learning "}).status_code == 404


def test_unlinked_canonicalizes_padded_title_when_plain_space_migration_is_active(
        client, seeded_config):
    import sqlite3

    con = sqlite3.connect(seeded_config.db_path)
    con.execute(
        "UPDATE sync_meta SET value = '1'"
        " WHERE key = 'plain_space_title_canonicalization'"
    )
    con.commit()
    con.close()

    r = client.get("/api/unlinked", params={"title": " Machine Learning "})

    assert r.status_code == 200
    body = r.json()
    assert body["total"] == 1
    [group] = body["groups"]
    assert group["page_title"] == "AI"
