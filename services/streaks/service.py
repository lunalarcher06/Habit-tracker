"""
Domain B — Streaks & Insights.

Computes current streak, longest streak, and completion rate
from check-in history.  Persists milestone events (7/14/30/60/100/365-day)
to the milestones table.

Handles daily habits (every day counts) and custom habits (only certain weekdays count)

The streak functions never touch the database: they get a {date: count}
dict (from habits.service.checkins_by_date) plus the habit's settings.
Only the milestone functions use `db`, and only the milestones table
(milestones_for_user also joins habits, to find the user's habits).

Note for self:
fetchone() -> returns one habit or none
fetchall() -> returns all habits as a list
"""
from datetime import date, timedelta

MILESTONE_DAYS = (7, 14, 30, 60, 100, 365)

#Mon=0 … Sun=6  
_WEEKDAY_BIT = {i: (1 << i) for i in range(7)}


def is_scheduled(day, frequency, weekdays_mask):
    """True if this calendar day is one the habit is supposed to be done on."""
    if frequency == "daily" or not weekdays_mask:
        return True
    return bool(weekdays_mask & _WEEKDAY_BIT[day.weekday()])


def _completed_days(checkins, target):
    """Sorted list of date objects where the habit met its daily target."""
    return sorted(date.fromisoformat(d) for d, count in checkins.items() if count >= target)


def current_streak(checkins, target=1, frequency="daily", weekdays_mask=None, as_of=None):
    """Consecutive *scheduled* days ending today (or as_of) where count >= target.

    Grace period: if today is scheduled but not yet completed, the streak
    is counted from yesterday so it doesn't drop to 0 every morning.
    """
    as_of = as_of or date.today()
    day_set = set(_completed_days(checkins, target))
    if not day_set:
        return 0

    # Grace period: if as_of is scheduled but not done, start from yesterday
    check = as_of
    if is_scheduled(check, frequency, weekdays_mask) and check not in day_set:
        check -= timedelta(days=1)

    streak = 0
    while True:
        # Skip non-scheduled days (rest days aren't gaps)
        if not is_scheduled(check, frequency, weekdays_mask):
            check -= timedelta(days=1)
            continue
        if check in day_set:
            streak += 1
            check -= timedelta(days=1)
        else:
            break
    return streak


def longest_streak(checkins, target=1, frequency="daily", weekdays_mask=None):
    """Longest run of consecutive *scheduled* completed days ever recorded."""
    days = _completed_days(checkins, target)
    if not days:
        return 0

    best = 1
    run = 1
    for i in range(1, len(days)):
        # Count non-scheduled days between the two completed days
        gap_has_scheduled = False
        d = days[i - 1] + timedelta(days=1)
        while d < days[i]:
            if is_scheduled(d, frequency, weekdays_mask):
                gap_has_scheduled = True
                break
            d += timedelta(days=1)

        if not gap_has_scheduled:
            run += 1
            best = max(best, run)
        else:
            run = 1
    return best


def completion_rate(checkins, target=1, frequency="daily", weekdays_mask=None,
                    window_days=30, as_of=None, created_on=None):
    """Fraction of *scheduled* days in the window where count >= target (0.0–1.0).

    created_on is the habit's created_at ("YYYY-MM-DD"). The window is
    clamped so it never extends before it — new habits aren't penalised
    for days that didn't exist yet.
    """
    as_of = as_of or date.today()
    start = as_of - timedelta(days=window_days - 1)

    # Clamp to the habit's creation date
    if created_on:
        created = date.fromisoformat(created_on[:10])
        if created > start:
            start = created

    # Count the scheduled days in the window, and how many of them were done
    done = set(_completed_days(checkins, target))
    scheduled = hit = 0
    d = start
    while d <= as_of:
        if is_scheduled(d, frequency, weekdays_mask):
            scheduled += 1
            if d in done:
                hit += 1
        d += timedelta(days=1)

    if scheduled == 0:
        return 0.0
    return hit / scheduled


def week_states(checkins, target=1, frequency="daily", weekdays_mask=None,
                as_of=None, created_on=None):
    """The current week, Monday to Sunday, as one word per day for the
    "This week" grid: "done", "missed", "rest" (not scheduled), "today",
    "today-done", or "none" (after today, or before the habit existed)."""
    as_of = as_of or date.today()
    created = date.fromisoformat(created_on[:10]) if created_on else None
    done = set(_completed_days(checkins, target))
    monday = as_of - timedelta(days=as_of.weekday())

    states = []
    for i in range(7):
        d = monday + timedelta(days=i)
        if d > as_of or (created and d < created):
            states.append("none")
        elif not is_scheduled(d, frequency, weekdays_mask):
            states.append("rest")
        elif d == as_of:
            states.append("today-done" if d in done else "today")
        else:
            states.append("done" if d in done else "missed")
    return states


def check_and_award_milestones(db, user_id, habit_id, streak, as_of=None):
    """Awards any milestones the current streak has reached that this habit
    doesn't have yet. Returns a list of the new day-counts."""
    as_of = as_of or date.today()
    awarded = []

    for threshold in MILESTONE_DAYS:
        if streak < threshold:
            break  # sorted ascending, no point checking further

        already = db.execute(
            "SELECT 1 AS found FROM milestones WHERE habit_id = %s AND streak_length = %s",
            (habit_id, threshold),
        ).fetchone()

        if not already:
            db.execute(
                """INSERT INTO milestones (user_id, habit_id, streak_length, achieved_on)
                   VALUES (%s, %s, %s, %s)""",
                (user_id, habit_id, threshold, as_of.isoformat()),
            )
            awarded.append(threshold)

    if awarded:
        db.commit()
    return awarded


def milestones_for_habit(db, habit_id):
    """All milestones earned for one habit, oldest first."""
    return db.execute(
        "SELECT * FROM milestones WHERE habit_id = %s ORDER BY achieved_on",
        (habit_id,),
    ).fetchall()


def milestones_for_user(db, user_id):
    """All milestones across all of a user's habits, newest first."""
    return db.execute(
        "SELECT * FROM milestones WHERE user_id = %s ORDER BY achieved_on DESC",
        (user_id,),
    ).fetchall()
