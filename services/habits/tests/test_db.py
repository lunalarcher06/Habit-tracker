import db as database


def test_migrations_are_recorded_and_run_only_once(db):
    database.migrate(db)   # everything is already applied: must not fail or wipe data
    versions = [r["version"] for r in db.execute("SELECT version FROM schema_migrations").fetchall()]
    assert versions == ["001_init.sql"]
    assert db.execute("SELECT COUNT(*) AS n FROM users").fetchone()["n"] == 2


def test_new_migration_file_is_applied_once(db, tmp_path, monkeypatch):
    (tmp_path / "001_init.sql").write_text("SELECT 1")          # already recorded: skipped
    (tmp_path / "002_extra.sql").write_text("CREATE TABLE zz_test (id INT)")
    monkeypatch.setattr(database, "MIGRATIONS_DIR", tmp_path)
    try:
        database.migrate(db)
        database.migrate(db)                                      # second run does nothing
        count = db.execute("SELECT COUNT(*) AS n FROM schema_migrations WHERE version = '002_extra.sql'")
        assert count.fetchone()["n"] == 1
    finally:
        db.execute("IF OBJECT_ID('zz_test') IS NOT NULL DROP TABLE zz_test")
        db.execute("DELETE FROM schema_migrations WHERE version = '002_extra.sql'")
        db.commit()


def test_foreign_keys_are_enforced(db):
    db.execute("INSERT INTO habits (user_id, name) VALUES (1, 'Read')")
    db.execute("DELETE FROM users WHERE id = 1")
    assert db.execute("SELECT COUNT(*) AS n FROM habits").fetchone()["n"] == 0
