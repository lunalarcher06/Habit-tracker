# Architecture Decision Records

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
Status: Decided

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
