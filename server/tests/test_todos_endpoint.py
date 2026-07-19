"""GET /api/todos: {{TODO}}-marker listing (pkm-w05j)."""
import pytest


@pytest.fixture()
def todo_client(client):
    ops = [
        {"op": "create", "uid": "todo_a1", "page_title": "AI",
         "parent_uid": None, "order_idx": 1, "text": "{{TODO}} read survey"},
        {"op": "create", "uid": "todo_a2", "page_title": "AI",
         "parent_uid": None, "order_idx": 2,
         "text": "{{[[TODO]]}} bracketed variant"},
        {"op": "create", "uid": "todo_a3", "page_title": "AI",
         "parent_uid": None, "order_idx": 3, "text": "{{DONE}} finished"},
        {"op": "create", "uid": "todo_a4", "page_title": "AI",
         "parent_uid": None, "order_idx": 4,
         "text": "mentions TODO mid-text only"},
        {"op": "create", "uid": "todo_p1", "page_title": "Paper",
         "parent_uid": None, "order_idx": 0, "text": "> {{TODO}} quoted task"},
    ]
    r = client.post("/api/ops", json={"client_id": "t", "ops": ops})
    assert r.status_code == 200
    return client


def test_todos_lists_only_todo_markers_grouped_by_page(todo_client):
    r = todo_client.get("/api/todos")
    assert r.status_code == 200
    body = r.json()
    assert body["total"] == 3
    by_page = {g["page_title"]: [i["uid"] for i in g["items"]]
               for g in body["groups"]}
    assert by_page == {"AI": ["todo_a1", "todo_a2"], "Paper": ["todo_p1"]}


def test_todos_page_filter(todo_client):
    r = todo_client.get("/api/todos", params={"page": "Paper"})
    body = r.json()
    assert body["total"] == 1
    assert body["groups"][0]["items"][0]["uid"] == "todo_p1"


def test_todos_unknown_page_is_empty_not_404(todo_client):
    body = todo_client.get("/api/todos", params={"page": "Nope"}).json()
    assert body == {"groups": [], "total": 0}


def test_todos_requires_auth(anon_client):
    assert anon_client.get("/api/todos").status_code == 401
