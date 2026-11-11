# Habit Buddy

Habit Buddy is a habit tracker for laptops. You can create habits, tick them off each day, and see your streaks, completion rates, and milestone badges at 7, 14, 30, 60, 100, and 365 days.

Assignment 2 splits the app into two Flask services that talk over HTTP, each with its own SQL Server database. **Work in progress:** the services, migrations, Dockerfiles and `docker compose` work locally; the static UI, CI, Azure deployment and the second migration are still to come.

## Services

| Service | Port | Owns | Contract |
|---|---|---|---|
| Habits (`services/habits`) | 8001 | users, habit groups, habits, check-ins; issues the login token (JWT) | `openapi.yaml` |
| Streaks (`services/streaks`) | 8002 | milestones; computes streaks | `openapi.yaml` |

How they work together (see ADR 6 and 7):
- The user logs in at Habits and gets a JWT. Both services check it with the same `JWT_SECRET`.
- Streaks gets the check-ins by calling Habits' `GET /history` with the user's own token and a 3-second timeout.
- Habits never calls Streaks. Streaks awards milestones when it computes a streak.
- If Habits is down, Streaks answers `503 habits_unavailable`. `/milestones` and `/health` only use Streaks' own database, so they keep working.

## Run everything with Docker

```bash
cp .env.example .env        # then put your own passwords and JWT_SECRET in .env
docker compose up --build
```

This starts SQL Server (`mcr.microsoft.com/mssql/server:2022-latest`), a one-off `db-init` job, the two services and the UI:

| URL | What |
|---|---|
| http://localhost:8001/health | Habits |
| http://localhost:8002/health | Streaks |
| http://localhost:8080 | UI (placeholder page for now) |

`db-init` runs `db/init.sql`, which creates the `habits` and `streaks` databases and one login for each. Each login can only use its own database, and the script is safe to run again. On Apple Silicon, SQL Server runs through emulation, so enable Rosetta in Docker Desktop and give it a minute to start. The data lives in the `sqldata` volume, so `docker compose down` keeps it and `docker compose down -v` deletes it.

Each service applies its numbered migrations (`services/<name>/migrations/NNN_*.sql`) when it starts. The `schema_migrations` table records which ones have run, so each runs exactly once.

To see the partial-failure behaviour: `docker compose stop habits`, then call `http://localhost:8002/streaks` (503) and `/milestones` (still 200).

## Run one service on its own

Start the database first (`docker compose up -d sqlserver db-init`), then:

```bash
cd services/habits          # or services/streaks
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
DATABASE_URL="mssql://habits_user:<password>@localhost:1433/habits" JWT_SECRET=<secret> python app.py
```

## Environment variables

| Variable | Default | Used by | Description |
|---|---|---|---|
| `PORT` | `8001` / `8002` | both | Port the service listens on |
| `DATABASE_URL` | none (required) | both | `mssql://user:password@host:1433/database` |
| `JWT_SECRET` | none (required) | both | Must be the same in both services |
| `HABITS_URL` | `http://localhost:8001` | Streaks | Where to find Habits |
| `HABITS_TIMEOUT_S` | `3` | Streaks | Timeout in seconds for calls to Habits |
| `UI_ORIGIN` | `http://localhost:8080` | both | The only origin allowed by CORS |
| `GIT_SHA` | `dev` | both | Reported as `version` by `/health` |

`docker compose` also reads `SA_PASSWORD`, `HABITS_DB_PASSWORD` and `STREAKS_DB_PASSWORD` from `.env`. The real `.env` is not committed.

## Project structure

```
habit-tracker/
├── docker-compose.yml        # SQL Server, db-init, habits, streaks, ui
├── .env.example              # the variables compose needs (copy to .env)
├── system.yaml               # every service, its settings, its calls and its Azure resources
├── db/
│   ├── init.sql              # databases and logins (idempotent)
│   └── init_test.sql         # extra databases for the test suites
├── services/
│   ├── habits/
│   │   ├── app.py            # Flask routes, token check, /health, /history
│   │   ├── service.py        # groups, habits, check-ins
│   │   ├── auth.py           # signup, login, password hashing
│   │   ├── db/               # connect() and the migration runner
│   │   ├── migrations/       # 001_init.sql, ...
│   │   ├── tests/
│   │   ├── Dockerfile
│   │   ├── openapi.yaml
│   │   └── requirements.txt
│   └── streaks/              # same layout: app.py, service.py, db/, migrations/, tests/
├── ui/                       # static UI (placeholder page for now)
├── ADR.md                    # architecture decision records
├── AI_USAGE.md               # AI usage log
└── README.md
```

`app.py`, `templates/`, `static/`, `Dockerfile` and `requirements.txt` at the repo root are the Assignment 1 version of the app. They stay until the static `ui/` replaces them, and the root `app.py` no longer starts.

## Testing

The tests need a SQL Server, because they run the real migrations and queries. Create the test databases once, then run each suite from its folder:

```bash
docker compose up -d sqlserver db-init
docker compose run --rm db-init /bin/bash -c '/opt/mssql-tools18/bin/sqlcmd -S sqlserver -U sa -P "$SA_PASSWORD" -C -b -i /db/init_test.sql'

cd services/habits
TEST_DATABASE_URL="mssql://habits_user:<password>@localhost:1433/habits_test" python -m pytest tests -v --cov=.
cd ../streaks
TEST_DATABASE_URL="mssql://streaks_user:<password>@localhost:1433/streaks_test" python -m pytest tests -v --cov=.
```

Habits has 59 tests and Streaks has 42. Each test starts from empty tables. The service tests call the functions directly. The route tests use Flask's test client, and the Streaks route tests replace the call to Habits with a fake, including the case where Habits is down.

## CI and images

`.github/workflows/ci.yml` runs on every push and pull request:
- **`test`** (one job per service): installs the service, lints it with `ruff`, validates its `openapi.yaml`, starts a throwaway SQL Server container with random masked passwords, and runs the tests. The job fails if coverage is below 70%.
- **`images`** (after `test` passes): builds each service's Docker image. Only on `main` it also pushes the image to `ghcr.io/<owner>/habit-buddy-<service>:<commit sha>`, using the built-in `GITHUB_TOKEN`.

To run a published image: `docker run --rm ghcr.io/<owner>/habit-buddy-habits:<sha>`. It starts and then fails to connect to a database, because there is no `DATABASE_URL`.

## Still to do

I still need to build the static UI, validate `system.yaml` against `system.schema.json` in CI, deploy to Azure, write the second migration with before/after evidence, add an integration test across the seam, and write ADRs 8–10.
