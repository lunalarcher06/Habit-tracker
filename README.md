# Habit Buddy

Habit Buddy is a habit tracker for laptops. You can create habits, tick them off each day, and see your streaks and completion rates. The first time you open the Milestones page you pick a colour for your cat's room (Cream, Pink or Sage), and streak milestones fill it (a yarn ball at 3 days, then a food bowl, scratching post, bed, plant, rug, window, cat tree and fish tank at 7, 14, 21, 30, 45, 60, 90 and 100 days; up to 5 at a time, and you choose which on the Milestones page), and the three longest unlock outfits he can wear: Chill at 150, Cool cat at 200 and King at 365 days.

Assignment 2 splits the app into two Flask services that talk over HTTP, each with its own SQL Server database. The services, migrations, Dockerfiles and `docker compose` work locally; the static UI, CI and the second migration are done; and every push to `main` deploys to Azure (see [Deploy to Azure](#deploy-to-azure)).

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
cp .env.example .env        
docker compose up --build
```

This starts SQL Server (`mcr.microsoft.com/mssql/server:2022-latest`), a one-off `db-init` job, the two services and the UI:

| URL | What |
|---|---|
| http://localhost:8001/health | Habits |
| http://localhost:8002/health | Streaks |
| http://localhost:8080 | UI |

`db-init` runs `db/init.sql`, which creates the `habits` and `streaks` databases and one login for each. Each login can only use its own database, and the script is safe to run again. On Apple Silicon, SQL Server runs through emulation, so enable Rosetta in Docker Desktop and give it a minute to start. The data lives in the `sqldata` volume, so `docker compose down` keeps it and `docker compose down -v` deletes it.

Each service applies its numbered migrations (`services/<name>/migrations/NNN_*.sql`; Habits has `001_init` to `006_add_wall`, Streaks has `001_init` and `002_rewards_room_items`; every migration after the first changes a table that already holds rows and keeps them) when it starts. The `schema_migrations` table records which ones have run, so each runs exactly once.

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
├── tests/integration/        # the test across the seam (both services running)
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
├── ui/                       # static UI: index.html, app.js, style.css, buddy-cat.js (the cat), cat/ (its pictures)
├── ADR.md                    # architecture decision records
├── AI_USAGE.md               # AI usage log
└── README.md
```

The Assignment 1 version of the app (the root `app.py`, `templates/` and `static/`) was removed once the static `ui/` replaced it. It is still in the git history.

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

Habits has 68 tests and Streaks has 44. Each test starts from empty tables. The service tests call the functions directly. The route tests use Flask's test client, and the Streaks route tests replace the call to Habits with a fake, including the case where Habits is down.

### Integration test across the seam

`tests/integration/test_seam.py` starts the real Habits and Streaks services as two separate processes, each with its own test database, and talks to them only over HTTP. It checks that a token issued by Habits is accepted by Streaks, that a streak and a 7-day milestone are worked out from data that lives in Habits, that one user cannot see another user's data, and that with Habits stopped Streaks answers `503` in under 5 seconds while `/milestones` and `/health` keep working. It needs both test databases, so run it from the repo root with:

```bash
HABITS_TEST_DATABASE_URL="mssql://habits_user:<password>@localhost:1433/habits_test" \
STREAKS_TEST_DATABASE_URL="mssql://streaks_user:<password>@localhost:1433/streaks_test" \
python -m pytest tests/integration -v
```

CI runs it as its own `integration` job, and the images are only built after it passes.

## CI and images

`.github/workflows/ci.yml` runs on every push and pull request:
- **`test`** (one job per service): installs the service, lints it with `ruff`, validates its `openapi.yaml`, starts a throwaway SQL Server container with random masked passwords, and runs the tests. The job fails if coverage is below 70%.
- **`integration`**: starts SQL Server and runs the integration test above.
- **`images`** (after `test` and `integration` pass): builds each service's Docker image. Only on `main` it also pushes the image to `ghcr.io/<owner>/habit-buddy-<service>:<commit sha>`, using the built-in `GITHUB_TOKEN`.

To run a published image: `docker run --rm ghcr.io/<owner>/habit-buddy-habits:<sha>`. It starts and then fails to connect to a database, because there is no `DATABASE_URL`.

## Deploy to Azure

**Live:** https://lalarcherieu2024ui.z43.web.core.windows.net

Everything runs in my Azure for Students subscription, in the resource group `rg-lalarcher-ieu2024` (Spain Central), and is pay-per-use (ADR 8).

**One-time setup** (with my own account, in Azure Cloud Shell or after `az login`):

```bash
bash infra/azure-setup.sh
```

It creates the storage static website for the UI, the SQL server with one serverless database and one user per service, the Container Apps environment with both apps (min 0, max 1 replica), and the managed identity the pipeline signs in as. It asks for the passwords and stores them only as Container App secrets. At the end it prints the values to add in GitHub under *Settings > Secrets and variables > Actions*:

- secrets `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`
- variables `PREFIX`, `RESOURCE_GROUP`, `UI_STORAGE`

After the first push to `main`, make the two packages on ghcr.io public (package settings), so Azure can pull them without a token.

**Every push to `main`** runs `.github/workflows/deploy.yml`: the whole CI first, then, only if it passes, both Container Apps switch to the image of that commit, `ui/config.js` is written with the services' addresses, the UI is uploaded to the static website, and the run fails unless both `/health` endpoints answer 200 within 4 minutes. Nothing is changed in the portal by hand.

## Migration evidence

`docs/evidence/migrations-before.txt` and `migrations-after.txt` show the live data on Azure before and after migrations Habits 003–006 and Streaks 002: every check-in is kept, the milestone rows are kept with their rewards renamed, and the startup logs show each migration applied once.

## Still to do

- Validate `system.yaml` against `system.schema.json` in CI (waiting for the schema file).
