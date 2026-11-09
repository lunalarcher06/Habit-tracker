"""Tests run against a real SQL Server (the streaks_test database).
Set TEST_DATABASE_URL (see the README)."""
import os

import pytest

import db as database

TEST_URL = os.environ.get("TEST_DATABASE_URL", "")


@pytest.fixture
def db():
    """A migrated database with an empty milestones table and ids starting at 1 again."""
    if not TEST_URL:
        pytest.fail("Set TEST_DATABASE_URL to the streaks_test database (see README).")
    conn = database.connect(TEST_URL)
    database.migrate(conn)
    conn.execute("DELETE FROM milestones")
    conn.execute("DBCC CHECKIDENT ('milestones', RESEED, 0)")
    conn.commit()
    yield conn
    conn.close()
