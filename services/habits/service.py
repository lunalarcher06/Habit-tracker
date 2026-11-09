"""
Domain A — Habits & Check-ins.

"""

from datetime import date

FREQUENCIES = ("daily", "custom")


def create_group(db, user_id, name):
    """Creates a group at the end of the user's list and returns its id."""
    name = (name or "").strip()
    if not name:
        raise ValueError("group name is required")
    cur = db.execute(
        """INSERT INTO habit_groups (user_id, name, position)
           VALUES (%s, %s, (SELECT COALESCE(MAX(position) + 1, 0)
                          FROM habit_groups WHERE user_id = %s))""",
        (user_id, name, user_id),
    )
    db.commit()
    return cur.lastrowid


def list_groups(db, user_id):
    return db.execute(
        "SELECT * FROM habit_groups WHERE user_id = %s ORDER BY position, id",
        (user_id,),
    ).fetchall()


def get_owned_group(db, user_id, group_id):
    """The group, or None if it doesn't exist or belongs to someone else."""
    return db.execute(
        "SELECT * FROM habit_groups WHERE id = %s AND user_id = %s", (group_id, user_id)
    ).fetchone()


def delete_group(db, user_id, group_id):
    """Deletes the group; its habits stay and become ungrouped."""
    db.execute(
        "UPDATE habits SET group_id = NULL WHERE group_id = %s AND user_id = %s",
        (group_id, user_id),
    )
    db.execute(
        "DELETE FROM habit_groups WHERE id = %s AND user_id = %s", (group_id, user_id)
    )
    db.commit()


def set_habit_group(db, user_id, habit_id, group_id):
    """Moves a habit into a group, or out of any group when group_id is None."""
    if get_owned_habit(db, user_id, habit_id) is None:
        raise ValueError("habit not found for this user")
    if group_id is not None and get_owned_group(db, user_id, group_id) is None:
        raise ValueError("group not found for this user")
    db.execute(
        "UPDATE habits SET group_id = %s WHERE id = %s AND user_id = %s",
        (group_id, habit_id, user_id),
    )
    db.commit()


def create_habit(db, user_id, name, frequency="daily", weekdays_mask=None,
                 target_count_per_day=1, group_id=None):
    if group_id is not None and get_owned_group(db, user_id, group_id) is None:
        raise ValueError("group not found for this user")
    if target_count_per_day < 1:
        raise ValueError("target_count_per_day must be at least 1")
    if frequency not in FREQUENCIES:
        raise ValueError(f"frequency must be one of {FREQUENCIES}")
    if frequency == "custom" and not (weekdays_mask and 0 < weekdays_mask < 128):
        raise ValueError("custom habits need at least one weekday")
    cur = db.execute(
        """INSERT INTO habits (user_id, group_id, name, frequency, weekdays_mask,
                              target_count_per_day)
           VALUES (%s, %s, %s, %s, %s, %s)""",
        (user_id, group_id, name, frequency, weekdays_mask, target_count_per_day),
    )
    db.commit()
    return cur.lastrowid


def archive_habit(db, user_id, habit_id):
    db.execute(
        "UPDATE habits SET archived = 1 WHERE id = %s AND user_id = %s",
        (habit_id, user_id),
    )
    db.commit()


def list_habits(db, user_id, group_id=None):
    """The user's active habits, oldest first; only one group's if group_id is given."""
    sql = "SELECT * FROM habits WHERE user_id = %s AND archived = 0"
    params = [user_id]
    if group_id is not None:
        sql += " AND group_id = %s"
        params.append(group_id)
    return db.execute(sql + " ORDER BY created_at, id", params).fetchall()


def get_owned_habit(db, user_id, habit_id):
    """The habit, or None if it doesn't exist or belongs to someone else."""
    return db.execute(
        "SELECT * FROM habits WHERE id = %s AND user_id = %s", (habit_id, user_id)
    ).fetchone()


def _count_on(db, habit_id, day):
    row = db.execute(
        "SELECT count FROM checkins WHERE habit_id = %s AND date = %s", (habit_id, day)
    ).fetchone()
    return row["count"] if row else 0


def log_checkin(db, user_id, habit_id, day=None):
    """Adds 1 to the habit's count for the day and returns the new count."""
    if get_owned_habit(db, user_id, habit_id) is None:
        raise ValueError("habit not found for this user")
    day = day or date.today().isoformat()
    # SQL Server has no ON CONFLICT: update the day's row, and insert it if none was updated
    db.execute(
        """UPDATE checkins WITH (UPDLOCK, SERIALIZABLE) SET count = count + 1
           WHERE habit_id = %s AND date = %s;
           IF @@ROWCOUNT = 0
               INSERT INTO checkins (habit_id, date, count) VALUES (%s, %s, 1)""",
        (habit_id, day, habit_id, day),
    )
    db.commit()
    return _count_on(db, habit_id, day)


def undo_checkin(db, user_id, habit_id, day=None):
    if get_owned_habit(db, user_id, habit_id) is None:
        raise ValueError("habit not found for this user")
    day = day or date.today().isoformat()
    db.execute(
        "UPDATE checkins SET count = CASE WHEN count > 0 THEN count - 1 ELSE 0 END WHERE habit_id = %s AND date = %s",
        (habit_id, day),
    )
    db.commit()
    return _count_on(db, habit_id, day)

#The check in dictionary 
def checkins_by_date(db, habit_id):
    rows = db.execute(
        "SELECT date, count FROM checkins WHERE habit_id = %s", (habit_id,)
    ).fetchall()
    return {str(r["date"]): r["count"] for r in rows}   # dates come back as date objects
