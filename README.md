# Habit Buddy

Habit Buddy is a habit tracker for laptops. You can create habits, tick them off each day, and see your streaks, completion rates, and milestone badges at 7, 14, 30, 60, 100, and 365 days.

Assignment 2 splits the app into two Flask services that talk to each other over HTTP. For now, they still run locally with SQLite. The SQL Server version, Docker, CI, and Azure deployment are still coming in the next commits.

## Services

| Service | Port | Owns | Contract |
|---|---|---|---|
| Habits (`services/habits`) | 8001 | users, habit groups, habits, and check-ins; also issues the login token (JWT) | `openapi.yaml` |
| Streaks (`services/streaks`) | 8002 | milestones; calculates streaks | `openapi.yaml` |

## How the services work together

- You log in through Habits and get a JWT token. Both services check the same token using the same `JWT_SECRET`.
- Streaks gets check-in data by calling Habits' `GET /history` endpoint with the user's token. It waits up to 3 seconds.
- Habits does not call Streaks. Streaks awards milestones when it calculates a streak.
- If Habits is down, Streaks returns `503 habits_unavailable`.
- `/milestones` and `/health` only use Streaks' own database, so they still work even if Habits is unavailable.

## Environment variables

| Variable | Default | Used by | Description |
|---|---|---|---|
| `PORT` | `8001` / `8002` | both | Port the service runs on |
| `DATABASE_URL` | `habits.db` / `streaks.db` | both | Database file for now |
| `JWT_SECRET` | `dev-secret-change-in-production` | both | Must match in both services |
| `HABITS_URL` | `http://localhost:8001` | Streaks | Where Streaks finds Habits |
| `UI_ORIGIN` | `http://localhost:8080` | both | Allowed CORS origin |
| `GIT_SHA` | `dev` | both | Shown as the version in `/health` |

## Running locally

Use one terminal for each service.

```bash
cd services/habits
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python app.py
```

```bash
cd services/streaks
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python app.py
```

To try it, sign up and log in at `http://localhost:8001/auth/signup` and `/auth/login`, then call `http://localhost:8002/streaks` with `Authorization: Bearer <token>`.

## Project structure

```text
habit-tracker/
├── services/
│   ├── habits/
│   │   ├── app.py            # Flask routes, token check, /health, /history
│   │   ├── service.py        # groups, habits, check-ins
│   │   ├── auth.py           # signup, login, password hashing
│   │   ├── db/               # connect() and schema.sql
│   │   ├── migrations/       # empty for now
│   │   ├── tests/
│   │   ├── openapi.yaml
│   │   └── requirements.txt
│   └── streaks/
│       ├── app.py            # Flask routes, calls Habits, /health
│       ├── service.py        # streak maths and milestones
│       ├── db/
│       ├── migrations/
│       ├── tests/
│       ├── openapi.yaml
│       └── requirements.txt
├── ui/                       # static UI, still to be built
├── ADR.md                    # architecture decision records
├── AI_USAGE.md               # AI usage log
└── README.md
```

`app.py`, `templates/`, `static/`, `Dockerfile`, and the root `requirements.txt` are from Assignment 1. They stay for now until the static `ui/` replaces them.

## Testing

Run the tests from inside each service folder:

```bash
cd services/habits && python -m pytest tests -v
cd services/streaks && python -m pytest tests -v
```

Habits has 57 tests and Streaks has 41. The service tests call the functions directly. The route tests use Flask's test client with a temporary database, and the Streaks route tests replace the call to Habits with a fake, including the case where Habits is down. Coverage is about 98% for Habits and 99% for Streaks.

## Still to do

I still need to add SQL Server and numbered migrations, Dockerfiles and `docker compose`, the static UI, CI with the 70% coverage gate, Azure deployment, and ADRs 7–10.