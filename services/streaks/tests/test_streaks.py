#Test domain B

import pytest
from datetime import date, timedelta
from service import (
    current_streak, longest_streak, completion_rate, week_states,
    check_and_award_milestones, milestones_for_habit, milestones_for_user,
)

MON_WED_FRI = 21  # weekdays_mask: Mon=1 + Wed=4 + Fri=16


def _n_days(n, end_date, count=1):
    return {(end_date - timedelta(days=i)).isoformat(): count for i in range(n)}


#Current streak
class TestCurrentStreak:
    def test_no_checkins(self):
        assert current_streak({}, as_of=date(2026, 10, 6)) == 0

    def test_one_day(self):
        assert current_streak({"2026-10-06": 1}, as_of=date(2026, 10, 6)) == 1

    def test_consecutive_days(self):
        assert current_streak(_n_days(5, date(2026, 10, 6)), as_of=date(2026, 10, 6)) == 5

    def test_gap_breaks_streak(self):
        checkins = {"2026-10-03": 1, "2026-10-05": 1, "2026-10-06": 1}  # Oct 4 missed
        assert current_streak(checkins, as_of=date(2026, 10, 6)) == 2

    def test_target_count(self):
        # Only logged twice on Oct 6 — below the target of 3
        assert current_streak({"2026-10-06": 2}, target=3, as_of=date(2026, 10, 6)) == 0
        # Third log meets the target
        assert current_streak({"2026-10-06": 3}, target=3, as_of=date(2026, 10, 6)) == 1

    def test_grace_period_morning(self):
        """If today is scheduled but not done yet, streak counts from yesterday."""
        checkins = {"2026-10-05": 1, "2026-10-06": 1}
        assert current_streak(checkins, as_of=date(2026, 10, 7)) == 2

    def test_missed_yesterday_is_zero(self):
        """The grace period is one day only: missing yesterday breaks the streak."""
        checkins = {"2026-10-04": 1, "2026-10-05": 1}
        assert current_streak(checkins, as_of=date(2026, 10, 7)) == 0

    def test_custom_weekday_skips_rest_days(self):
        """Mon/Wed/Fri habit: Tue and Thu are rest days, not gaps."""
        checkins = {"2026-10-05": 1, "2026-10-07": 1, "2026-10-09": 1}  # Mon, Wed, Fri
        assert current_streak(checkins, 1, "custom", MON_WED_FRI, as_of=date(2026, 10, 9)) == 3


#The longest streak
class TestLongestStreak:
    def test_no_checkins(self):
        assert longest_streak({}) == 0

    def test_single_day(self):
        assert longest_streak({"2026-10-01": 1}) == 1

    def test_past_streak_longer_than_current(self):
        checkins = _n_days(5, date(2026, 9, 30))             # 5-day streak in the past
        checkins.update({"2026-10-05": 1, "2026-10-06": 1})  # gap, then 2 days
        assert longest_streak(checkins) == 5
        assert current_streak(checkins, as_of=date(2026, 10, 6)) == 2

    def test_custom_weekday_longest(self):
        """Longest streak for a Mon/Wed/Fri habit spanning rest days."""
        checkins = {"2026-10-05": 1, "2026-10-07": 1}  # Mon, Wed
        assert longest_streak(checkins, 1, "custom", MON_WED_FRI) == 2


class TestCompletionRate:
    def test_empty(self):
        assert completion_rate({}, as_of=date(2026, 10, 6)) == 0.0

    def test_perfect_week(self):
        rate = completion_rate(_n_days(7, date(2026, 10, 6)), window_days=7,
                               as_of=date(2026, 10, 6))
        assert rate == pytest.approx(1.0)

    def test_half_window(self):
        rate = completion_rate(_n_days(5, date(2026, 10, 6)), window_days=10,
                               as_of=date(2026, 10, 6))
        assert rate == pytest.approx(0.5)

    def test_new_habit_not_penalised(self):
        """A habit created today and done today should show 100%, not 3%."""
        rate = completion_rate({"2026-10-06": 1}, as_of=date(2026, 10, 6),
                               created_on="2026-10-06")
        assert rate == pytest.approx(1.0)

    def test_no_scheduled_days_in_window(self):
        """Window is just a Tuesday, which a Mon/Wed/Fri habit never has."""
        rate = completion_rate({}, 1, "custom", MON_WED_FRI, window_days=1,
                               as_of=date(2026, 10, 6))
        assert rate == 0.0

    def test_rest_day_checkin_does_not_inflate_rate(self):
        """A Mon/Wed/Fri habit logged on a Tuesday can't go above 100%."""
        checkins = {"2026-10-05": 1, "2026-10-06": 1, "2026-10-07": 1}  # Mon, Tue, Wed
        rate = completion_rate(checkins, 1, "custom", MON_WED_FRI, window_days=3,
                               as_of=date(2026, 10, 7))
        assert rate == pytest.approx(1.0)

#Insights
class TestMilestones:
    def test_7_day_milestone(self, db):
        hid = 1
        assert 7 in check_and_award_milestones(db, 1, hid, streak=7, as_of=date(2026, 10, 6))

    def test_no_duplicate_milestone(self, db):
        hid = 1
        check_and_award_milestones(db, 1, hid, streak=7, as_of=date(2026, 10, 6))
        # Calling again should not re-award
        assert check_and_award_milestones(db, 1, hid, streak=7, as_of=date(2026, 10, 6)) == []

    def test_multiple_milestones_at_once(self, db):
        hid = 1
        awarded = check_and_award_milestones(db, 1, hid, streak=14, as_of=date(2026, 10, 6))
        assert awarded == [7, 14]

    def test_milestones_for_habit(self, db):
        hid = 1
        check_and_award_milestones(db, 1, hid, streak=7, as_of=date(2026, 10, 6))
        ms = milestones_for_habit(db, hid)
        assert len(ms) == 1
        assert ms[0]["streak_length"] == 7

    def test_milestones_for_user(self, db):
        h1 = 1
        h2 = 2
        check_and_award_milestones(db, 1, h1, streak=7, as_of=date(2026, 10, 6))
        check_and_award_milestones(db, 1, h2, streak=14, as_of=date(2026, 10, 6))
        assert len(milestones_for_user(db, 1)) == 3  # 7 for h1, 7+14 for h2

    def test_streak_too_short_no_milestone(self, db):
        hid = 1
        assert check_and_award_milestones(db, 1, hid, streak=5, as_of=date(2026, 10, 6)) == []


class TestWeekStates:
    # 2026-10-07 is a Wednesday, so the week is Mon 5 Oct .. Sun 11 Oct

    def test_daily_habit_midweek(self):
        checkins = {"2026-10-05": 1, "2026-10-07": 1}  # Mon done, Tue missed, Wed (today) done
        assert week_states(checkins, as_of=date(2026, 10, 7)) == [
            "done", "missed", "today-done", "none", "none", "none", "none"]

    def test_today_not_done_yet(self):
        assert week_states({}, as_of=date(2026, 10, 7))[2] == "today"

    def test_target_count(self):
        # Monday logged once, but the target is 2, so it counts as missed
        assert week_states({"2026-10-05": 1}, target=2, as_of=date(2026, 10, 7))[0] == "missed"

    def test_custom_habit_rest_days(self):
        checkins = {"2026-10-05": 1}  # Mon/Wed/Fri habit
        assert week_states(checkins, 1, "custom", MON_WED_FRI, as_of=date(2026, 10, 7))[:3] == [
            "done", "rest", "today"]

    def test_days_before_creation_are_blank(self):
        states = week_states({}, as_of=date(2026, 10, 7), created_on="2026-10-06")
        assert states[:3] == ["none", "missed", "today"]
