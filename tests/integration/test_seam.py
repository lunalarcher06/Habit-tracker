"""Integration test across the seam: the real Habits and Streaks services, started as
separate processes for Assignment 1, each with its own real SQL Server database.
Everything goes over HTTP, so this checks what unit tests cannot: for example, that a token issued by
Habits is accepted by Streaks, and that Streaks really calls Habits' /history.

Needs two test databases, so set both:
  HABITS_TEST_DATABASE_URL=mssql://habits_user:<pw>@localhost:1433/habits_test
  STREAKS_TEST_DATABASE_URL=mssql://streaks_user:<pw>@localhost:1433/streaks_test
Run from the repo root:  python -m pytest tests/integration -v
The last test stops Habits on purpose, so keep it last in the file."""
import os
import socket
import subprocess
import sys
import time
import uuid
from datetime import date, timedelta
from pathlib import Path

import pytest
import requests

ROOT = Path(__file__).resolve().parents[2]
JWT_SECRET = "integration-test-secret"


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def start(service, port, env):
    process = subprocess.Popen(
        [sys.executable, "app.py"], cwd=ROOT / "services" / service,
        env={**os.environ, "PORT": str(port), "JWT_SECRET": JWT_SECRET, **env},
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    for _ in range(60):
        try:
            if requests.get(f"http://127.0.0.1:{port}/health", timeout=1).status_code == 200:
                return process
        except requests.RequestException:
            pass
        if process.poll() is not None:
            break
        time.sleep(0.5)
    process.terminate()
    pytest.fail(f"{service} did not start")


@pytest.fixture(scope="module")
def stack():
    habits_db = os.environ.get("HABITS_TEST_DATABASE_URL")
    streaks_db = os.environ.get("STREAKS_TEST_DATABASE_URL")
    if not habits_db or not streaks_db:
        pytest.fail("Set HABITS_TEST_DATABASE_URL and STREAKS_TEST_DATABASE_URL (see the top of this file).")
    habits_port, streaks_port = free_port(), free_port()
    habits = start("habits", habits_port, {"DATABASE_URL": habits_db})
    streaks = start("streaks", streaks_port, {
        "DATABASE_URL": streaks_db, "HABITS_URL": f"http://127.0.0.1:{habits_port}",
        "HABITS_TIMEOUT_S": "2",
    })
    yield {"habits": f"http://127.0.0.1:{habits_port}", "streaks": f"http://127.0.0.1:{streaks_port}",
           "habits_process": habits}
    for process in (habits, streaks):
        process.terminate()
        process.wait(timeout=10)


def new_user(stack):
    username = "it_" + uuid.uuid4().hex[:10]
    body = {"first_name": "Test", "last_name": "User", "username": username, "password": "password1"}
    assert requests.post(f"{stack['habits']}/auth/signup", json=body).status_code == 201
    token = requests.post(f"{stack['habits']}/auth/login",
                          json={"username": username, "password": "password1"}).json()["token"]
    return {"Authorization": f"Bearer {token}"}


def new_habit_with_streak(stack, headers, days, name="Read"):
    habit = requests.post(f"{stack['habits']}/habits", json={"name": name}, headers=headers).json()
    for i in range(days):
        day = (date.today() - timedelta(days=i)).isoformat()
        r = requests.post(f"{stack['habits']}/habits/{habit['id']}/checkins", json={"date": day}, headers=headers)
        assert r.status_code == 200
    return habit["id"]


def test_streak_is_computed_from_habits_data(stack):
    headers = new_user(stack)            # the token comes from Habits, Streaks must accept it
    habit_id = new_habit_with_streak(stack, headers, days=3)

    r = requests.get(f"{stack['streaks']}/streaks", headers=headers)
    assert r.status_code == 200
    [streak] = r.json()["streaks"]
    assert streak["habit_id"] == habit_id
    assert streak["name"] == "Read"
    assert streak["current_streak"] == 3
    assert streak["longest_streak"] == 3

    one = requests.get(f"{stack['streaks']}/streaks/{habit_id}", headers=headers)
    assert one.json()["current_streak"] == 3


def test_milestone_is_stored_by_streaks_and_listed(stack):
    headers = new_user(stack)
    habit_id = new_habit_with_streak(stack, headers, days=7)

    first = requests.get(f"{stack['streaks']}/streaks", headers=headers).json()["streaks"][0]
    assert first["new_milestones"] == [7]
    again = requests.get(f"{stack['streaks']}/streaks", headers=headers).json()["streaks"][0]
    assert again["new_milestones"] == []          # awarded only once

    milestones = requests.get(f"{stack['streaks']}/milestones", headers=headers).json()["milestones"]
    assert [(m["habit_id"], m["streak_length"]) for m in milestones] == [(habit_id, 7)]


def test_users_only_see_their_own_data_across_the_seam(stack):
    alice, bob = new_user(stack), new_user(stack)
    habit_id = new_habit_with_streak(stack, alice, days=2)

    assert requests.get(f"{stack['streaks']}/streaks", headers=bob).json() == {"streaks": []}
    assert requests.get(f"{stack['streaks']}/streaks/{habit_id}", headers=bob).status_code == 404
    assert requests.get(f"{stack['streaks']}/milestones", headers=bob).json() == {"milestones": []}


def test_streaks_rejects_a_missing_or_forged_token(stack):
    assert requests.get(f"{stack['streaks']}/streaks").status_code == 401
    assert requests.get(f"{stack['streaks']}/streaks",
                        headers={"Authorization": "Bearer not-a-real-token"}).status_code == 401


def test_when_habits_is_stopped_streaks_fails_clearly_and_keeps_its_own_data(stack):
    headers = new_user(stack)
    new_habit_with_streak(stack, headers, days=7)
    requests.get(f"{stack['streaks']}/streaks", headers=headers)   # stores the 7-day milestone

    stack["habits_process"].terminate()
    stack["habits_process"].wait(timeout=10)

    started = time.time()
    r = requests.get(f"{stack['streaks']}/streaks", headers=headers)
    assert r.status_code == 503
    assert r.json()["error"]["code"] == "habits_unavailable"
    assert time.time() - started < 5            # an error, not a hang

    # Streaks' own domain still works
    assert requests.get(f"{stack['streaks']}/health").json()["status"] == "ok"
    milestones = requests.get(f"{stack['streaks']}/milestones", headers=headers)
    assert milestones.status_code == 200
    assert [m["streak_length"] for m in milestones.json()["milestones"]] == [7]
