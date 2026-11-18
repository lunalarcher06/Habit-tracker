import db as database


def test_migrations_are_recorded_and_run_only_once(db):
    database.migrate(db)   # everything is already applied: must not fail or wipe data
    versions = [r["version"] for r in db.execute("SELECT version FROM schema_migrations").fetchall()]
    assert versions == ["001_init.sql", "002_add_outfit.sql", "003_add_checkin_updated_at.sql", "004_retire_old_outfits.sql", "005_add_room.sql", "006_add_wall.sql"]
    assert db.execute("SELECT COUNT(*) AS n FROM users").fetchone()["n"] == 2


def test_new_migration_file_is_applied_once(db, tmp_path, monkeypatch):
    (tmp_path / "001_init.sql").write_text("SELECT 1")          # already recorded: skipped
    (tmp_path / "900_extra.sql").write_text("CREATE TABLE zz_test (id INT)")
    monkeypatch.setattr(database, "MIGRATIONS_DIR", tmp_path)
    try:
        database.migrate(db)
        database.migrate(db)                                      # second run does nothing
        count = db.execute("SELECT COUNT(*) AS n FROM schema_migrations WHERE version = '900_extra.sql'")
        assert count.fetchone()["n"] == 1
    finally:
        db.execute("IF OBJECT_ID('zz_test') IS NOT NULL DROP TABLE zz_test")
        db.execute("DELETE FROM schema_migrations WHERE version = '900_extra.sql'")
        db.commit()


def test_foreign_keys_are_enforced(db):
    db.execute("INSERT INTO habits (user_id, name) VALUES (1, 'Read')")
    db.execute("DELETE FROM users WHERE id = 1")
    assert db.execute("SELECT COUNT(*) AS n FROM habits").fetchone()["n"] == 0


def test_migration_002_fills_existing_users_with_none(db):
    # Go back to the state before migration 002: users exist, but there is no outfit column yet.
    db.execute("ALTER TABLE users DROP CONSTRAINT df_users_outfit")
    db.execute("ALTER TABLE users DROP COLUMN outfit")
    db.execute("DELETE FROM schema_migrations WHERE version = '002_add_outfit.sql'")
    db.commit()
    database.migrate(db)
    outfits = [r["outfit"] for r in db.execute("SELECT outfit FROM users").fetchall()]
    assert outfits == ["none", "none"]      # the two users that were already there


def test_migration_003_backfills_existing_checkins(db):
    # Go back to the state before migration 003: a check-in exists, but there is no updated_at yet.
    db.execute("INSERT INTO habits (user_id, name) VALUES (1, 'Read')")
    hid = db.execute("SELECT MAX(id) AS id FROM habits").fetchone()["id"]
    db.execute("INSERT INTO checkins (habit_id, date, count) VALUES (%s, '2026-10-01', 2)", (hid,))
    db.execute("ALTER TABLE checkins DROP CONSTRAINT df_checkins_updated_at")
    db.execute("ALTER TABLE checkins DROP COLUMN updated_at")
    db.execute("DELETE FROM schema_migrations WHERE version = '003_add_checkin_updated_at.sql'")
    db.commit()
    database.migrate(db)
    row = db.execute("SELECT count, updated_at FROM checkins WHERE habit_id = %s", (hid,)).fetchone()
    assert row["count"] == 2                                     # the row and its data are kept
    assert row["updated_at"].isoformat().startswith("2026-10-01T00:00")   # backfilled from its date


def test_migration_004_takes_off_retired_outfits(db):
    # Before 004 a user could wear any of the 12 old outfits; only 3 are left.
    db.execute("UPDATE users SET outfit = 'chef' WHERE id = 1")
    db.execute("UPDATE users SET outfit = 'royal' WHERE id = 2")
    db.execute("DELETE FROM schema_migrations WHERE version = '004_retire_old_outfits.sql'")
    db.commit()
    database.migrate(db)
    rows = db.execute("SELECT id, outfit FROM users ORDER BY id").fetchall()
    assert [(r["id"], r["outfit"]) for r in rows] == [(1, "none"), (2, "royal")]
