import db as database


def test_migrations_are_recorded_and_run_only_once(db):
    database.migrate(db)   # everything is already applied: must not fail
    versions = [r["version"] for r in db.execute("SELECT version FROM schema_migrations").fetchall()]
    assert versions == ["001_init.sql", "002_rewards_room_items.sql"]


def test_migration_002_renames_rewards_and_keeps_rows(db):
    # Milestones recorded before 002 carry the old outfit names.
    db.execute(
        """INSERT INTO milestones (user_id, habit_id, streak_length, item_unlocked, achieved_on)
           VALUES (1, 1, 3, 'headphones', '2026-11-01'), (1, 1, 7, 'cool', '2026-11-05'),
                  (2, 5, 150, 'ninja', '2026-10-01')"""
    )
    db.execute("DELETE FROM schema_migrations WHERE version = '002_rewards_room_items.sql'")
    db.commit()
    database.migrate(db)
    rows = db.execute(
        "SELECT user_id, habit_id, streak_length, item_unlocked, achieved_on FROM milestones ORDER BY id"
    ).fetchall()
    assert [(r["user_id"], r["habit_id"], r["streak_length"], r["item_unlocked"], str(r["achieved_on"])) for r in rows] == [
        (1, 1, 3, "yarn", "2026-11-01"),
        (1, 1, 7, "bowl", "2026-11-05"),
        (2, 5, 150, "headphones", "2026-10-01"),
    ]
