"""Tests run against a real SQL Server (the habits_test database).
Start it with `docker compose up -d sqlserver db-init`, run db/init_test.sql, and set
TEST_DATABASE_URL (see the README)."""
import os

import pytest

import db as database

TEST_URL = os.environ.get("TEST_DATABASE_URL", "")
os.environ.setdefault("JWT_SECRET", "test-only-secret")   # app.py reads it when it is imported

# children first, so foreign keys never block the delete
TABLES = ["checkins", "habits", "habit_groups", "users"]


@pytest.fixture
def clean_db():
    """A migrated database with every table empty and the ids starting at 1 again."""
    if not TEST_URL:
        pytest.fail("Set TEST_DATABASE_URL to the habits_test database (see README).")
    conn = database.connect(TEST_URL)
    database.migrate(conn)
    for table in TABLES:
        conn.execute(f"DELETE FROM {table}")
        conn.execute(f"DBCC CHECKIDENT ('{table}', RESEED, 0)")
    conn.commit()
    yield conn
    conn.close()


@pytest.fixture
def db(clean_db):
    """clean_db plus two users: Luna (id 1) and Other (id 2)."""
    for first, username in (("Luna", "luna"), ("Other", "other")):
        clean_db.execute(
            "INSERT INTO users (first_name, last_name, username, password_hash) "
            "VALUES (%s, 'User', %s, 'x')", (first, username))
    clean_db.commit()
    return clean_db
