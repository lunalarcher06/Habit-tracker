"""Habits service: users, groups, habits, check-ins. 
Creates and returns a JWT token after login, and follows the API rules written in openapi.yml"""
import logging
import os
import time
from datetime import date
from functools import wraps

import jwt
from flask import Flask, g, jsonify, request

import db as database
from auth import register_user, authenticate_user, get_user_by_id
from service import (
    create_group, list_groups, get_owned_group, delete_group, set_habit_group,
    create_habit, list_habits, get_owned_habit,
    log_checkin, undo_checkin, checkins_by_date,
)

app = Flask(__name__)
logging.getLogger("werkzeug").setLevel(logging.ERROR)   # we print our own line per request
JWT_SECRET = os.environ.get("JWT_SECRET")   # secret, no default; same value in both services
DATABASE_URL = os.environ.get("DATABASE_URL")   # secret, no default: mssql://user:password@host:1433/database
UI_ORIGIN = os.environ.get("UI_ORIGIN", "http://localhost:8080")
VERSION = os.environ.get("GIT_SHA", "dev")
TOKEN_SECONDS = 3600


def error(code, message, status):
    return jsonify({"error": {"code": code, "message": message}}), status


# Database connection: one per request and closed right after.
def get_db():
    if "db" not in g:
        g.db = database.connect(DATABASE_URL)
    return g.db


@app.teardown_appcontext
def close_db(_exc):
    conn = g.pop("db", None)
    if conn is not None:
        conn.close()


# Check if the login token is valid
def token_required(view):
    @wraps(view)
    def wrapper(*args, **kwargs):
        header = request.headers.get("Authorization", "")
        if not header.startswith("Bearer "):
            return error("unauthorized", "Missing bearer token.", 401)
        try:
            claims = jwt.decode(header[7:], JWT_SECRET, algorithms=["HS256"])
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
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, PATCH, DELETE, OPTIONS"
    return response

def body():
    return request.get_json(silent=True) or {}

def habit_json(row):
    return {
        "id": row["id"], "name": row["name"], "group_id": row["group_id"],
        "frequency": row["frequency"], "weekdays_mask": row["weekdays_mask"],
        "target_count_per_day": row["target_count_per_day"],
        "archived": bool(row["archived"]), "created_at": str(row["created_at"]),
    }


def group_json(row):
    return {"id": row["id"], "name": row["name"], "position": row["position"]}


def user_json(row):
    return {"id": row["id"], "first_name": row["first_name"],
            "last_name": row["last_name"], "username": row["username"]}


def checkin_state(habit, day, count):
    target = habit["target_count_per_day"]
    return {"habit_id": habit["id"], "date": day, "count": count,
            "target": target, "complete": count >= target}


def read_day(value):
    if not value:
        return date.today().isoformat()
    day = date.fromisoformat(value)
    if day > date.today():
        raise ValueError("date cannot be in the future")
    return day.isoformat()

@app.get("/health")
def health():
    try:
        conn = database.connect(DATABASE_URL, retries=1)   # fail fast, don't keep retrying
        conn.execute("SELECT 1 AS ok")
        conn.close()
        return jsonify({"status": "ok", "db": "ok", "version": VERSION})
    except Exception:
        return jsonify({"status": "error", "db": "error", "version": VERSION}), 503

@app.post("/auth/signup")
def signup():
    data = body()
    try:
        user_id = register_user(get_db(), data.get("first_name"), data.get("last_name"),
                                data.get("username"), data.get("password"))
    except ValueError as e:
        if "already taken" in str(e):
            return error("username_taken", str(e), 409)
        return error("validation_error", str(e), 422)
    return jsonify(user_json(get_user_by_id(get_db(), user_id))), 201

@app.post("/auth/login")
def login():
    data = body()
    user = authenticate_user(get_db(), data.get("username"), data.get("password"))
    if user is None:
        return error("invalid_credentials", "Wrong username or password.", 401)
    claims = {"sub": str(user["id"]), "exp": int(time.time()) + TOKEN_SECONDS}
    token = jwt.encode(claims, JWT_SECRET, algorithm="HS256")
    return jsonify({"token": token, "expires_in": TOKEN_SECONDS, "user": user_json(user)})

#Groups
@app.get("/groups")
@token_required
def groups_list():
    return jsonify([group_json(r) for r in list_groups(get_db(), g.user_id)])


@app.post("/groups")
@token_required
def groups_create():
    try:
        group_id = create_group(get_db(), g.user_id, body().get("name"))
    except ValueError as e:
        return error("validation_error", str(e), 422)
    return jsonify(group_json(get_owned_group(get_db(), g.user_id, group_id))), 201


@app.delete("/groups/<int:group_id>")
@token_required
def groups_delete(group_id):
    if get_owned_group(get_db(), g.user_id, group_id) is None:
        return error("not_found", "Group not found.", 404)
    delete_group(get_db(), g.user_id, group_id)
    return "", 204


#Habits
@app.get("/habits")
@token_required
def habits_list():
    group_id = request.args.get("group_id", type=int)
    rows = list_habits(get_db(), g.user_id, group_id)
    return jsonify([habit_json(r) for r in rows])


@app.post("/habits")
@token_required
def habits_create():
    data = body()
    name = (data.get("name") or "").strip()
    if not name:
        return error("validation_error", "name is required", 422)
    try:
        habit_id = create_habit(
            get_db(), g.user_id, name,
            frequency=data.get("frequency", "daily"),
            weekdays_mask=data.get("weekdays_mask"),
            target_count_per_day=data.get("target_count_per_day", 1),
            group_id=data.get("group_id"),
        )
    except ValueError as e:
        return error("validation_error", str(e), 422)
    return jsonify(habit_json(get_owned_habit(get_db(), g.user_id, habit_id))), 201


@app.get("/habits/<int:habit_id>")
@token_required
def habits_get(habit_id):
    habit = get_owned_habit(get_db(), g.user_id, habit_id)
    if habit is None:
        return error("not_found", "Habit not found.", 404)
    return jsonify(habit_json(habit))


@app.patch("/habits/<int:habit_id>")
@token_required
def habits_update(habit_id):
    data = body()
    if not data or set(data) - {"name", "group_id", "archived"}:
        return error("validation_error", "Only name, group_id and archived can change.", 422)
    db = get_db()
    if get_owned_habit(db, g.user_id, habit_id) is None:
        return error("not_found", "Habit not found.", 404)
    try:
        if "name" in data:
            name = (data["name"] or "").strip()
            if not name:
                raise ValueError("name cannot be empty")
            db.execute("UPDATE habits SET name = %s WHERE id = %s", (name, habit_id))
            db.commit()
        if "group_id" in data:
            set_habit_group(db, g.user_id, habit_id, data["group_id"])
        if "archived" in data:
            db.execute("UPDATE habits SET archived = %s WHERE id = %s",
                       (1 if data["archived"] else 0, habit_id))
            db.commit()
    except ValueError as e:
        return error("validation_error", str(e), 422)
    return jsonify(habit_json(get_owned_habit(db, g.user_id, habit_id)))

#Check-in
@app.post("/habits/<int:habit_id>/checkins")
@token_required
def checkin_add(habit_id):
    habit = get_owned_habit(get_db(), g.user_id, habit_id)
    if habit is None:
        return error("not_found", "Habit not found.", 404)
    try:
        day = read_day(body().get("date"))
    except ValueError as e:
        return error("validation_error", str(e), 422)
    count = log_checkin(get_db(), g.user_id, habit_id, day)
    return jsonify(checkin_state(habit, day, count))


@app.delete("/habits/<int:habit_id>/checkins")
@token_required
def checkin_undo(habit_id):
    habit = get_owned_habit(get_db(), g.user_id, habit_id)
    if habit is None:
        return error("not_found", "Habit not found.", 404)
    try:
        day = read_day(request.args.get("date"))
    except ValueError as e:
        return error("validation_error", str(e), 422)
    count = undo_checkin(get_db(), g.user_id, habit_id, day)
    return jsonify(checkin_state(habit, day, count))


# Gives the check-in history for one or more habits, to streaks service.
@app.get("/history")
@token_required
def history():
    db = get_db()
    habit_id = request.args.get("habit_id", type=int)
    start, end = request.args.get("from"), request.args.get("to")
    include_archived = request.args.get("include_archived") == "true"

    if habit_id is not None:
        habit = get_owned_habit(db, g.user_id, habit_id)
        if habit is None:
            return error("not_found", "Habit not found.", 404)
        habits = [habit]
    else:
        habits = db.execute("SELECT * FROM habits WHERE user_id = %s ORDER BY id",
                            (g.user_id,)).fetchall()

    result = []
    for h in habits:
        if h["archived"] and not include_archived and habit_id is None:
            continue
        checkins = []
        for day, count in sorted(checkins_by_date(db, h["id"]).items()):
            if (start and day < start) or (end and day > end):
                continue
            checkins.append({"date": day, "count": count})
        result.append({
            "habit_id": h["id"], "name": h["name"], "frequency": h["frequency"],
            "weekdays_mask": h["weekdays_mask"],
            "target_count_per_day": h["target_count_per_day"],
            "created_at": str(h["created_at"]), "checkins": checkins,
        })
    return jsonify({"habits": result})


if __name__ == "__main__":
    if not DATABASE_URL or not JWT_SECRET:
        raise SystemExit("DATABASE_URL and JWT_SECRET must be set")
    startup_db = database.connect(DATABASE_URL)
    database.migrate(startup_db)          # applies any migration that has not run yet
    startup_db.close()
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 8001)))
