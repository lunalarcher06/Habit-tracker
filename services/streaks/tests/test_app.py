"""Route tests for the Streaks API. Habits is faked by replacing requests.get."""
from datetime import date, timedelta
from types import SimpleNamespace

import jwt
import pytest
import requests

import app as streaks_app
from conftest import TEST_URL


@pytest.fixture
def client(db, monkeypatch):
    monkeypatch.setattr(streaks_app, "DATABASE_URL", TEST_URL)
    return streaks_app.app.test_client()


def auth_header(user_id=1):
    token = jwt.encode({"sub": str(user_id)}, streaks_app.JWT_SECRET, algorithm="HS256")
    return {"Authorization": f"Bearer {token}"}


def fake_habits(monkeypatch, habits=None, status=200, error=None):
    """Replaces the HTTP call to Habits. Returns the list of calls it received."""
    calls = []

    def fake_get(url, params=None, headers=None, timeout=None):
        calls.append({"url": url, "params": params, "headers": headers, "timeout": timeout})
        if error:
            raise error
        return SimpleNamespace(status_code=status, json=lambda: {"habits": habits or []})

    monkeypatch.setattr(streaks_app.requests, "get", fake_get)
    return calls


def history_entry(days, habit_id=1):
    today = date.today()
    return {"habit_id": habit_id, "name": "Read", "frequency": "daily", "weekdays_mask": None,
            "target_count_per_day": 1, "created_at": (today - timedelta(days=days)).isoformat(),
            "checkins": [{"date": (today - timedelta(days=i)).isoformat(), "count": 1}
                         for i in range(days)]}


def test_health(client):
    assert client.get("/health").get_json() == {"status": "ok", "db": "ok", "version": "dev"}


def test_needs_a_token(client):
    assert client.get("/streaks").status_code == 401
    assert client.get("/milestones").status_code == 401
    assert client.get("/streaks", headers={"Authorization": "Bearer nonsense"}).status_code == 401


def test_streaks_are_computed_and_token_is_forwarded(client, monkeypatch):
    calls = fake_habits(monkeypatch, [history_entry(2)])
    headers = auth_header()
    streak = client.get("/streaks", headers=headers).get_json()["streaks"][0]
    assert streak["current_streak"] == 2
    assert streak["longest_streak"] == 2
    assert streak["new_milestones"] == []
    assert calls[0]["headers"]["Authorization"] == headers["Authorization"]
    assert calls[0]["timeout"] == streaks_app.HABITS_TIMEOUT


def test_milestone_is_awarded_once_and_listed(client, monkeypatch):
    fake_habits(monkeypatch, [history_entry(7)])
    first = client.get("/streaks", headers=auth_header()).get_json()["streaks"][0]
    again = client.get("/streaks", headers=auth_header()).get_json()["streaks"][0]
    assert first["new_milestones"] == [3, 7]
    assert again["new_milestones"] == []

    milestones = client.get("/milestones", headers=auth_header()).get_json()["milestones"]
    assert sorted(m["streak_length"] for m in milestones) == [3, 7]
    assert {m["item_unlocked"] for m in milestones} == {"headphones", "cool"}
    assert client.get("/milestones?habit_id=99", headers=auth_header()).get_json() == {"milestones": []}


def test_milestones_belong_to_one_user(client, monkeypatch):
    fake_habits(monkeypatch, [history_entry(7)])
    client.get("/streaks", headers=auth_header(user_id=1))
    assert client.get("/milestones", headers=auth_header(user_id=2)).get_json() == {"milestones": []}


def test_one_habit(client, monkeypatch):
    calls = fake_habits(monkeypatch, [history_entry(2, habit_id=5)])
    body = client.get("/streaks/5", headers=auth_header()).get_json()
    assert body["habit_id"] == 5
    assert calls[0]["params"] == {"habit_id": 5}


def test_unknown_habit_is_404(client, monkeypatch):
    fake_habits(monkeypatch, status=404)
    assert client.get("/streaks/99", headers=auth_header()).status_code == 404


@pytest.mark.parametrize("problem", [
    {"error": requests.ConnectionError()},
    {"error": requests.Timeout()},
    {"status": 500},
])
def test_habits_down_gives_503(client, monkeypatch, problem):
    fake_habits(monkeypatch, **problem)
    r = client.get("/streaks", headers=auth_header())
    assert r.status_code == 503
    assert r.get_json()["error"]["code"] == "habits_unavailable"


def test_milestones_and_health_work_while_habits_is_down(client, monkeypatch):
    fake_habits(monkeypatch, error=requests.ConnectionError())
    assert client.get("/milestones", headers=auth_header()).status_code == 200
    assert client.get("/health").status_code == 200


def test_cors_preflight(client):
    r = client.options("/streaks")
    assert r.status_code == 200   # Flask answers OPTIONS itself
    assert r.headers["Access-Control-Allow-Origin"] == streaks_app.UI_ORIGIN


def test_health_is_503_when_the_database_is_unreachable(client, monkeypatch):
    monkeypatch.setattr(streaks_app, "DATABASE_URL", "mssql://nobody:wrong@localhost:1/none")
    r = client.get("/health")
    assert r.status_code == 503
    assert r.get_json() == {"status": "error", "db": "error", "version": "dev"}
