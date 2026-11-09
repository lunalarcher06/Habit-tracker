#Route tests for the Habits API, using Flask's test client and a temporary database.
import pytest

import app as habits_app


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(habits_app, "DATABASE_URL", str(tmp_path / "test.db"))
    return habits_app.app.test_client()


def sign_up_and_log_in(client, username="alice"):
    client.post("/auth/signup", json={"first_name": "Test", "last_name": "User",
                                      "username": username, "password": "password1"})
    token = client.post("/auth/login", json={"username": username,
                                             "password": "password1"}).get_json()["token"]
    return {"Authorization": f"Bearer {token}"}


def test_health(client):
    assert client.get("/health").get_json() == {"status": "ok", "db": "ok", "version": "dev"}


def test_signup_and_duplicate(client):
    data = {"first_name": "A", "last_name": "B", "username": "alice", "password": "password1"}
    assert client.post("/auth/signup", json=data).status_code == 201
    assert client.post("/auth/signup", json=data).status_code == 409


def test_signup_validation(client):
    data = {"first_name": "A", "last_name": "B", "username": "alice", "password": "short"}
    assert client.post("/auth/signup", json=data).status_code == 422


def test_login_wrong_password(client):
    sign_up_and_log_in(client)
    r = client.post("/auth/login", json={"username": "alice", "password": "wrong-password"})
    assert r.status_code == 401
    assert r.get_json()["error"]["code"] == "invalid_credentials"


def test_login_returns_token_and_user(client):
    sign_up_and_log_in(client)
    body = client.post("/auth/login", json={"username": "alice", "password": "password1"}).get_json()
    assert body["expires_in"] == 3600
    assert body["user"]["username"] == "alice"


def test_routes_need_a_token(client):
    assert client.get("/habits").status_code == 401
    assert client.get("/habits", headers={"Authorization": "Bearer nonsense"}).status_code == 401


def test_group_create_list_delete(client):
    h = sign_up_and_log_in(client)
    group = client.post("/groups", json={"name": "Morning"}, headers=h).get_json()
    assert client.get("/groups", headers=h).get_json() == [group]
    assert client.delete(f"/groups/{group['id']}", headers=h).status_code == 204
    assert client.delete(f"/groups/{group['id']}", headers=h).status_code == 404


def test_habit_create_and_validation(client):
    h = sign_up_and_log_in(client)
    r = client.post("/habits", json={"name": "Read"}, headers=h)
    assert r.status_code == 201
    assert r.get_json()["frequency"] == "daily"
    assert client.post("/habits", json={"name": ""}, headers=h).status_code == 422
    assert client.post("/habits", json={"name": "Gym", "frequency": "custom"},
                       headers=h).status_code == 422


def test_habit_update_only_allowed_fields(client):
    h = sign_up_and_log_in(client)
    habit = client.post("/habits", json={"name": "Read"}, headers=h).get_json()
    url = f"/habits/{habit['id']}"
    assert client.patch(url, json={"name": "Read more"}, headers=h).get_json()["name"] == "Read more"
    assert client.patch(url, json={"frequency": "custom"}, headers=h).status_code == 422
    assert client.patch(url, json={"archived": True}, headers=h).get_json()["archived"] is True
    assert client.get("/habits", headers=h).get_json() == []   # archived habits are hidden


def test_habit_move_to_group(client):
    h = sign_up_and_log_in(client)
    group = client.post("/groups", json={"name": "Morning"}, headers=h).get_json()
    habit = client.post("/habits", json={"name": "Read"}, headers=h).get_json()
    moved = client.patch(f"/habits/{habit['id']}", json={"group_id": group["id"]}, headers=h)
    assert moved.get_json()["group_id"] == group["id"]
    assert client.patch(f"/habits/{habit['id']}", json={"group_id": 999}, headers=h).status_code == 422


def test_checkin_and_undo(client):
    h = sign_up_and_log_in(client)
    habit = client.post("/habits", json={"name": "Water", "target_count_per_day": 2},
                        headers=h).get_json()
    url = f"/habits/{habit['id']}/checkins"
    first = client.post(url, headers=h).get_json()
    assert (first["count"], first["target"], first["complete"]) == (1, 2, False)
    assert client.post(url, headers=h).get_json()["complete"] is True
    assert client.delete(url, headers=h).get_json()["count"] == 1


def test_checkin_rejects_future_date(client):
    h = sign_up_and_log_in(client)
    habit = client.post("/habits", json={"name": "Read"}, headers=h).get_json()
    r = client.post(f"/habits/{habit['id']}/checkins", json={"date": "2999-01-01"}, headers=h)
    assert r.status_code == 422


def test_users_cannot_see_each_others_habits(client):
    alice = sign_up_and_log_in(client, "alice")
    bob = sign_up_and_log_in(client, "bobby")
    habit = client.post("/habits", json={"name": "Read"}, headers=alice).get_json()
    assert client.get(f"/habits/{habit['id']}", headers=bob).status_code == 404
    assert client.post(f"/habits/{habit['id']}/checkins", headers=bob).status_code == 404
    assert client.get("/history", headers=bob).get_json() == {"habits": []}


def test_history(client):
    h = sign_up_and_log_in(client)
    habit = client.post("/habits", json={"name": "Read"}, headers=h).get_json()
    client.post(f"/habits/{habit['id']}/checkins", json={"date": "2026-10-05"}, headers=h)
    client.post(f"/habits/{habit['id']}/checkins", json={"date": "2026-10-06"}, headers=h)

    entry = client.get("/history", headers=h).get_json()["habits"][0]
    assert entry["name"] == "Read"
    assert entry["checkins"] == [{"date": "2026-10-05", "count": 1},
                                 {"date": "2026-10-06", "count": 1}]

    only_one_day = client.get("/history?from=2026-10-06", headers=h).get_json()["habits"][0]
    assert only_one_day["checkins"] == [{"date": "2026-10-06", "count": 1}]

    assert client.get("/history?habit_id=999", headers=h).status_code == 404


def test_history_hides_archived_unless_asked(client):
    h = sign_up_and_log_in(client)
    habit = client.post("/habits", json={"name": "Read"}, headers=h).get_json()
    client.patch(f"/habits/{habit['id']}", json={"archived": True}, headers=h)
    assert client.get("/history", headers=h).get_json() == {"habits": []}
    assert len(client.get("/history?include_archived=true", headers=h).get_json()["habits"]) == 1


def test_cors_header_and_preflight(client):
    r = client.options("/habits")
    assert r.status_code == 200   # Flask answers OPTIONS itself
    assert r.headers["Access-Control-Allow-Origin"] == habits_app.UI_ORIGIN
