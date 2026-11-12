
# Architecture Decision Record 
## 1. Backend Language & Framework Choice
Date: 2026-09-30
Status: Decided

Context: I needed a simple web app that could show pages, save data in SQLite, and run in one process. The app has two main jobs: managing habits/check-ins and calculating streaks.

Decision: I used Flask, Jinja2 templates, and plain SQL with Python's built-in `sqlite3`. I did not use an ORM.

Alternatives considered:
- **Django** — it has more built-in features, but I only needed a small app with a few tables. Most of Django would be unnecessary.
- **FastAPI** — good for APIs, but my app shows HTML pages, not a separate frontend.

Consequences: I have to write the SQL myself and set up things like foreign keys and `row_factory` manually. The advantage is that the app stays small and easy to explain.

## 2. Keeping the Two Domains Separate
Date: 2026-10-01
Status: Decided

Context: The app has two parts: **Habits & Check-ins** and **Streaks & Insights**. I wanted them to stay loosely connected so they could be split into separate services later.

Decision: Each domain has its own folder and `service.py`. The habits service handles creating, listing, archiving, and logging. The streaks service gets check-in data through `checkins_by_date()`, which returns a simple dictionary like `{"2026-10-07": 2}`. The streak functions only work with that data and do not touch the database. The streaks functions that do use the database (`check_and_award_milestones`, `milestones_for_habit`, `milestones_for_user`) only work with the `milestones` table, which belongs to the streaks domain.

Alternatives considered:
- **One big service file** — easier at the start, but harder to split later.
- **Letting streaks query the check-ins table directly** — it would work, but then the two domains would depend too much on the same table layout.

Consequences: If I ever split this into microservices, `checkins_by_date()` would just become an API call. The one remaining link is `milestones_for_user`, which joins `milestones` with `habits` to find a user's habits, so that query would need to change too. The downside is a little more setup now, but the code is cleaner and easier to test.

## 3. Data Model: Count-Based Check-ins and Per-Habit Milestones
Date: 2026-10-01
Status: Superseded by [7]

Context: Some habits need more than one check per day, like "drink 8 glasses of water." I also needed streaks and milestone badges.

Decision: The `checkins` table stores one row per habit per day, with a `count` column instead of a simple yes/no. A habit counts as done when `count >= target_count_per_day`. The `milestones` table links to `habit_id` instead of `user_id`, and `UNIQUE(habit_id, streak_length)` makes sure each milestone is only earned once per habit. To get all milestones for a user, I join through the `habits` table.

Alternatives considered:
- **A boolean check-in field** — simpler, but not enough for habits with multiple completions per day.
- **Putting `user_id` directly on milestones** — easier to query, but it repeats data that already exists on the habit.

Consequences: `log_checkin` uses `ON CONFLICT ... DO UPDATE SET count = count + 1`, so there are no duplicate rows for the same habit and day. The streak code can work from the check-in counts alone.

## 4. Testing Approach
Date: 2026-10-10
Status: Superseded by [9]

Context: I needed at least 70% coverage on the main logic using `pytest-cov`. I had to decide what to test properly and what to keep simple.

Decision: I test the service functions directly in `habits/service.py`, `streaks/service.py`, and `auth/service.py`. The habits, auth and milestone tests make a temporary in-memory SQLite database with the real schema and call the service functions directly. The streak tests don't need a database at all: they pass hand-built `{date: count}` dictionaries (built by the `_n_days` helper), so they are short and don't depend on today's date. I do not use Flask route tests.

Alternatives considered:
- **Testing through Flask routes** — this would cover the pages too, but most of the real logic is in the service layer.
- **Mocking the database** — faster, but it would miss real SQL mistakes like wrong column names or broken foreign keys.

Consequences: The service files have 100% coverage, which is where the graded logic lives. The routes and templates are checked manually in the browser.

## 5. Not Building the Desktop Companion App
Date: 2026-10-11
Status: Decided

Context: I wanted my cat Chabal to behave like a desktop pet that stays on top of other windows and sends reminders when a habit is still undone. That would need a separate always-running app.

Decision: I did not build the desktop version. The cat only lives inside the web app: on the dashboard, and roaming along the bottom of the login and register pages. Its mood comes from `cat_mode()` in `app.py` based on today's progress.

Alternatives considered:
- **A Tauri or Electron app** — this would feel more like a real desktop pet, but it would also add a second process and more setup.
- **Browser push notifications** — this would still need background service worker support and extra permissions.

Consequences: Everything stays in one Flask app, which fits the assignment better. The cat is just JavaScript and sprite images, and the streak logic could still be reused later if I ever build a desktop version.

## 6. The Split: Two Services Along the ADR-2 Seam
Date: 2026-11-04
Status: Decided

**Context:** For Assignment 2 I needed the app split into two services, one for habits and one for streaks. I already had that boundary in ADR 2, so I kept the same split instead of changing everything.

**Decision:** I kept the split at `checkins_by_date()`. The Habits service owns users, groups, habits, and check-ins. The Streaks service owns milestones and gets the check-in data by calling the Habits service over HTTP. The streak functions still work on a `{date: count}` dictionary, so the date math did not need to change. I also moved milestone awarding into the Streaks service, so logging a check-in does not need to call another service.

**Alternatives considered:**
- **Letting the browser talk to both services:** this would put too much logic in the frontend.
- **Keeping milestone awarding in Habits:** this would make the services depend on each other both ways.
- **Making accounts a separate service:** that would add another container I do not need. Make this assignment more complex.

**Consequences:** The split matches the way I already built the monolith, so it was easy to carry over. It does add a bit more setup, because the services now need HTTP calls, JWTs, and separate databases. But the streak logic stayed the same, which made the change simpler.

## 7. Milestones Keep Their Own user_id and Have No Foreign Key to Habits
Date: 2026-11-09
Status: Decided

Context: After the split in ADR 6, the Habits service and the Streaks service now live in separate databases. Streaks can no longer join the habits table, but it still needs to show milestones for one user.

Decision: I changed the milestones table in Streaks so it stores both user_id and habit_id as plain integers. The table still uses UNIQUE(habit_id, streak_length) so the same milestone cannot be earned twice for one habit. GET /milestones now filters by user_id using only the Streaks database.

**Alternatives considered:**
-**Asking Habits for the user’s habits every time /milestones is called:** this would make the endpoint depend on Habits being up.

-**Keeping a copy of the habits table in Streaks:** this would let me join across the data again, but the copy could go out of sync.

**Consequences:** This makes Streaks a bit less strict than the monolith, because user_id is now repeated data. But it means /milestones still works without calling Habits, which fits the split better. Deleting a user in Habits would leave their milestones behind, but that is fine for now because the app does not have delete-account support.

## 8. Serverless Hosting on Azure
Date: 2026-11-11
Status: Decided

Context: The assignment asks for a public system on Azure in a subscription whose budget is shared by the whole class, so nothing may have a fixed monthly cost. The system needs two services, one database per service, and a static UI.

Decision: Each service runs as an Azure Container App on the Consumption plan with a minimum of 0 and a maximum of 1 replica, and has its own Azure SQL Database on the serverless tier (General Purpose, Gen5, 0.5 to 1 vCore, auto-pause) on one logical SQL server. The UI is an Azure Static Web App and the images come from GitHub Container Registry, so everything is pay-per-use.

Alternatives considered:
- **An App Service plan or virtual machines** — they have a fixed monthly cost even when nobody uses the app, and the class budget is shared.
- **Azure Container Registry** — it has a monthly fee, and GHCR is free and already used by the pipeline.
- **One database for both services** — it is cheaper, but it breaks the rule from ADR 6 that each service owns its own data.

Consequences: Scale-to-zero means the first request after idle has to start the container and may find the database paused, which fails with error 40613 for up to about a minute, so `connect()` retries with backoff for about 60 seconds, and the cap of one replica means the migrations that run at startup can never run twice at the same time. At 100 times the traffic I would keep at least one replica running, allow more replicas and move the migrations to a one-off job so they still run once, and switch the databases to a provisioned tier with connection pooling.

## 9. Pipeline and Testing
Date: 2026-11-11
Status: Decided

Context: Assignment 2 needs a pipeline that stops a bad change before it is deployed. My tests from ADR 4 used in-memory SQLite, but the services now run on SQL Server, where the placeholders, the upsert and the date types all behave differently.

Decision: On every push and pull request, CI lints each service, validates its OpenAPI file, runs its tests against a throwaway SQL Server container with a 70% coverage minimum, and runs one integration test that starts the real Habits and Streaks processes with their own databases and talks to them only over HTTP, and the images are built only after all of that passes and pushed to GHCR only from main, tagged with the commit SHA. The integration test checks that a token from Habits works in Streaks, that a streak and a milestone are worked out from data stored in Habits, that users only see their own data, and that Streaks answers 503 and keeps `/milestones` working when the Habits process is stopped.

Alternatives considered:
- **Keeping the SQLite tests** — they are faster, but they would pass on SQL that SQL Server rejects, such as the upsert, so they prove less.
- **Replacing Habits with a stub in the integration test** — it is simpler, but it would not catch a mismatch between the stub and the real `/history`, or a token that Streaks refuses.
- **Running the integration test against the full compose stack** — it covers the containers too, but it is slower and CI would have to build and start every image before the tests.

Consequences: A change that breaks the seam, the migrations or a query fails CI before any image exists, at the cost of about a minute and a half per run and a SQL Server container in CI. What I deliberately do not test is the UI, the real network between containers, Azure SQL (CI never touches it, because every connection wakes it and is billed), race conditions between concurrent check-ins, and behaviour under load.
