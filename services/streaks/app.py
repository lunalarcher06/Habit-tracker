"""Streaks service: streak maths and milestones. Asks Habits for the check-ins.
Contract: openapi.yaml. Configuration comes from environment variables."""
import logging
import os
import time
from functools import wraps

import jwt
import requests
from flask import Flask, g, jsonify, request

import db as database
from service import (
    current_streak, longest_streak, completion_rate,
    check_and_award_milestones, milestones_for_user,
)

app = Flask(__name__)
logging.getLogger("werkzeug").setLevel(logging.ERROR)  
JWT_SECRET = os.environ.get("JWT_SECRET", "dev-secret-change-in-production")  
DATABASE_URL = os.environ.get("DATABASE_URL", "streaks.db")  
HABITS_URL = os.environ.get("HABITS_URL", "http://localhost:8001")
UI_ORIGIN = os.environ.get("UI_ORIGIN", "http://localhost:8080")
VERSION = os.environ.get("GIT_SHA", "dev")
HABITS_TIMEOUT = 3  


class HabitsUnavailable(Exception):
    pass


class HabitNotFound(Exception):
    pass


def error(code, message, status):
    return jsonify({"error": {"code": code, "message": message}}), status


def get_db():
    if "db" not in g:
        g.db = database.connect(DATABASE_URL)
        database.init_schema(g.db)
    return g.db


@app.teardown_appcontext
def close_db(_exc):
    conn = g.pop("db", None)
    if conn is not None:
        conn.close()

def token_required(view):
    @wraps(view)
    def wrapper(*args, **kwargs):
        header = request.headers.get("Authorization", "")
        if not header.startswith("Bearer "):
            return error("unauthorized", "Missing bearer token.", 401)
        g.token = header[7:]
        try:
            claims = jwt.decode(g.token, JWT_SECRET, algorithms=["HS256"])
            g.user_id = int(claims["sub"])
        except (jwt.InvalidTokenError, KeyError, ValueError):
            return error("unauthorized", "Invalid or expired token.", 401)
        return view(*args, **kwargs)
    return wrapper


@app.before_request
def start_timer():
    g.started = time.time()


@app.after_request
def log_and_cors(response):
    ms = round((time.time() - g.get("started", time.time())) * 1000)
    print(f"{request.method} {request.path} {response.status_code} {ms}ms", flush=True)
    response.headers["Access-Control-Allow-Origin"] = UI_ORIGIN
    response.headers["Access-Control-Allow-Headers"] = "Authorization, Content-Type"
    response.headers["Access-Control-Allow-Methods"] = "GET, OPTIONS"
    return response


#Gets from habits service, the checkin history
def fetch_history(habit_id=None):
    params = {"habit_id": habit_id} if habit_id else {}
    try:
        resp = requests.get(f"{HABITS_URL}/history", params=params,
                            headers={"Authorization": f"Bearer {g.token}"},
                            timeout=HABITS_TIMEOUT)
    except requests.RequestException:       # down, refused or too slow
        raise HabitsUnavailable()
    if resp.status_code == 404:
        raise HabitNotFound()
    if resp.status_code != 200:
        raise HabitsUnavailable()
    return resp.json()["habits"]


@app.errorhandler(HabitsUnavailable)
def habits_down(_):
    return error("habits_unavailable", "The Habits service is not reachable.", 503)


@app.errorhandler(HabitNotFound)
def habit_missing(_):
    return error("not_found", "Habit not found.", 404)


@app.get("/health")
def health():
    try:
        get_db().execute("SELECT 1")
        return jsonify({"status": "ok", "db": "ok", "version": VERSION})
    except Exception:
        return jsonify({"status": "error", "db": "error", "version": VERSION}), 503


def streak_for(habit):
    checkins = {c["date"]: c["count"] for c in habit["checkins"]}
    args = (checkins, habit["target_count_per_day"], habit["frequency"], habit["weekdays_mask"])
    current = current_streak(*args)
    new = check_and_award_milestones(get_db(), g.user_id, habit["habit_id"], current)
    return {
        "habit_id": habit["habit_id"],
        "name": habit["name"],
        "current_streak": current,
        "longest_streak": longest_streak(*args),
        "completion_rate_30d": completion_rate(*args, created_on=habit["created_at"]),
        "new_milestones": new,
    }

#streaks
@app.get("/streaks")
@token_required
def streaks_all():
    return jsonify({"streaks": [streak_for(h) for h in fetch_history()]})


@app.get("/streaks/<int:habit_id>")
@token_required
def streaks_one(habit_id):
    habits = fetch_history(habit_id)
    if not habits:
        raise HabitNotFound()
    return jsonify(streak_for(habits[0]))

#milsetones
@app.get("/milestones")
@token_required
def milestones():
    habit_id = request.args.get("habit_id", type=int)
    rows = milestones_for_user(get_db(), g.user_id)
    return jsonify({"milestones": [
        {"habit_id": r["habit_id"], "streak_length": r["streak_length"],
         "item_unlocked": r["item_unlocked"], "achieved_on": r["achieved_on"]}
        for r in rows if habit_id is None or r["habit_id"] == habit_id
    ]})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 8002)))
