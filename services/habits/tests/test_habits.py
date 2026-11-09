#Test domain A

import pytest
from db import connect, init_schema
from service import (
    create_group, list_groups, get_owned_group, delete_group,
    set_habit_group, create_habit, archive_habit, list_habits,
    get_owned_habit, log_checkin, undo_checkin, checkins_by_date,
)


@pytest.fixture
def db():
    conn = connect(":memory:")
    init_schema(conn)
    conn.execute(
        "INSERT INTO users (id, first_name, last_name, username, password_hash) "
        "VALUES (1, 'Luna', 'Larcher', 'luna', 'x')"
    )
    conn.execute(
        "INSERT INTO users (id, first_name, last_name, username, password_hash) "
        "VALUES (2, 'Other', 'User', 'other', 'x')"
    )
    conn.commit()
    yield conn
    conn.close()
#Groups
class TestGroups:
    def test_create_and_list(self, db):
        gid = create_group(db, 1, "Morning")
        groups = list_groups(db, 1)
        assert len(groups) == 1
        assert groups[0]["name"] == "Morning"
        assert groups[0]["id"] == gid

    def test_create_empty_name_raises(self, db):
        with pytest.raises(ValueError):
            create_group(db, 1, "")

    def test_positions_auto_increment(self, db):
        create_group(db, 1, "A")
        create_group(db, 1, "B")
        groups = list_groups(db, 1)
        assert groups[0]["position"] < groups[1]["position"]

    def test_delete_group(self, db):
        gid = create_group(db, 1, "Temp")
        delete_group(db, 1, gid)
        assert list_groups(db, 1) == []

    def test_get_owned_group_wrong_user(self, db):
        gid = create_group(db, 1, "Mine")
        assert get_owned_group(db, 2, gid) is None
#Habits
class TestHabits:
    def test_create_and_list(self, db):
        hid = create_habit(db, 1, "Drink water")
        habits = list_habits(db, 1)
        assert len(habits) == 1
        assert habits[0]["name"] == "Drink water"
        assert habits[0]["id"] == hid

    def test_create_with_group(self, db):
        gid = create_group(db, 1, "Health")
        hid = create_habit(db, 1, "Stretch", group_id=gid)
        habit = get_owned_habit(db, 1, hid)
        assert habit["group_id"] == gid

    def test_create_with_bad_group_raises(self, db):
        with pytest.raises(ValueError):
            create_habit(db, 1, "Oops", group_id=999)

    def test_create_bad_target_raises(self, db):
        with pytest.raises(ValueError):
            create_habit(db, 1, "Bad", target_count_per_day=0)

    def test_create_bad_frequency_raises(self, db):
        with pytest.raises(ValueError):
            create_habit(db, 1, "Bad", frequency="weekly")

    def test_custom_needs_weekdays(self, db):
        with pytest.raises(ValueError):
            create_habit(db, 1, "Bad", frequency="custom", weekdays_mask=0)

    def test_archive_hides_from_list(self, db):
        hid = create_habit(db, 1, "Gone")
        archive_habit(db, 1, hid)
        assert list_habits(db, 1) == []

    def test_list_by_group(self, db):
        gid = create_group(db, 1, "G")
        create_habit(db, 1, "In group", group_id=gid)
        create_habit(db, 1, "No group")
        assert len(list_habits(db, 1, group_id=gid)) == 1

    def test_get_owned_habit_wrong_user(self, db):
        hid = create_habit(db, 1, "Mine")
        assert get_owned_habit(db, 2, hid) is None

    def test_set_habit_group(self, db):
        gid = create_group(db, 1, "G")
        hid = create_habit(db, 1, "Move me")
        set_habit_group(db, 1, hid, gid)
        assert get_owned_habit(db, 1, hid)["group_id"] == gid

    def test_set_habit_group_to_none(self, db):
        gid = create_group(db, 1, "G")
        hid = create_habit(db, 1, "Move me", group_id=gid)
        set_habit_group(db, 1, hid, None)
        assert get_owned_habit(db, 1, hid)["group_id"] is None

    def test_set_habit_group_bad_habit_raises(self, db):
        gid = create_group(db, 1, "G")
        with pytest.raises(ValueError):
            set_habit_group(db, 1, 999, gid)

    def test_set_habit_group_bad_group_raises(self, db):
        hid = create_habit(db, 1, "H")
        with pytest.raises(ValueError):
            set_habit_group(db, 1, hid, 999)
#Checkins
class TestCheckins:
    def test_log_creates_row(self, db):
        hid = create_habit(db, 1, "Read")
        count = log_checkin(db, 1, hid, "2026-10-01")
        assert count == 1

    def test_log_increments(self, db):
        hid = create_habit(db, 1, "Read")
        log_checkin(db, 1, hid, "2026-10-01")
        count = log_checkin(db, 1, hid, "2026-10-01")
        assert count == 2

    def test_log_wrong_user_raises(self, db):
        hid = create_habit(db, 1, "Mine")
        with pytest.raises(ValueError):
            log_checkin(db, 2, hid, "2026-10-01")

    def test_undo_decrements(self, db):
        hid = create_habit(db, 1, "Read")
        log_checkin(db, 1, hid, "2026-10-01")
        log_checkin(db, 1, hid, "2026-10-01")
        count = undo_checkin(db, 1, hid, "2026-10-01")
        assert count == 1

    def test_undo_never_below_zero(self, db):
        hid = create_habit(db, 1, "Read")
        log_checkin(db, 1, hid, "2026-10-01")
        undo_checkin(db, 1, hid, "2026-10-01")
        count = undo_checkin(db, 1, hid, "2026-10-01")
        assert count == 0

    def test_undo_wrong_user_raises(self, db):
        hid = create_habit(db, 1, "Mine")
        with pytest.raises(ValueError):
            undo_checkin(db, 2, hid, "2026-10-01")

    def test_checkins_by_date(self, db):
        hid = create_habit(db, 1, "Read")
        log_checkin(db, 1, hid, "2026-10-01")
        log_checkin(db, 1, hid, "2026-10-02")
        log_checkin(db, 1, hid, "2026-10-02")
        result = checkins_by_date(db, hid)
        assert result == {"2026-10-01": 1, "2026-10-02": 2}
