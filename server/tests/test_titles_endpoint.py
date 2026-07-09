def test_titles_prefix_ranks_before_substring(client):
    r = client.get("/api/titles", params={"q": "a"})
    assert r.status_code == 200
    # prefix matches ("AI", "Attention…") first, shorter first; then
    # substring matches ("Paper", "Machine Learning") shorter first.
    assert r.json()["titles"] == [
        "AI", "Attention Is All You Need", "Paper", "Machine Learning"]


def test_titles_matches_are_case_insensitive_substrings(client):
    assert client.get("/api/titles", params={"q": "learn"}).json() == {
        "titles": ["Machine Learning"]}


def test_titles_escapes_like_wildcards(client):
    assert client.get("/api/titles", params={"q": "%"}).json() == {"titles": []}
    assert client.get("/api/titles", params={"q": "_"}).json() == {"titles": []}


def test_titles_empty_query_returns_nothing(client):
    assert client.get("/api/titles").json() == {"titles": []}
    assert client.get("/api/titles", params={"q": "  "}).json() == {"titles": []}


def test_titles_requires_auth(anon_client):
    assert anon_client.get("/api/titles", params={"q": "a"}).status_code == 401
