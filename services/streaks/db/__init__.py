"""SQL Server access: connect, and apply the numbered migrations once each."""
import time
from pathlib import Path
from urllib.parse import urlparse, unquote

import pymssql

MIGRATIONS_DIR = Path(__file__).resolve().parent.parent / "migrations"


class Database:
    """A small wrapper so the service code can call db.execute(...) like before."""

    def __init__(self, conn):
        self.conn = conn

    def execute(self, sql, params=None):
        cur = self.conn.cursor()
        cur.execute(sql, tuple(params) if params else None)
        return cur

    def commit(self):
        self.conn.commit()

    def close(self):
        self.conn.close()


def connect(url, retries=5):
    """url looks like mssql://user:password@host:1433/database.
    Retries with a growing wait, because the server may still be starting
    (or, on Azure, waking up from pause with error 40613)."""
    parts = urlparse(url)
    wait = 1
    for attempt in range(retries):
        try:
            conn = pymssql.connect(
                server=parts.hostname, port=parts.port or 1433,
                user=unquote(parts.username or ""), password=unquote(parts.password or ""),
                database=parts.path.lstrip("/"), as_dict=True,
                login_timeout=5, timeout=10,
            )
            return Database(conn)
        except pymssql.Error:
            if attempt == retries - 1:
                raise
            time.sleep(wait)
            wait *= 2


def migrate(db):
    """Runs every migrations/NNN_*.sql that is not yet in schema_migrations, in order,
    each exactly once. A migration that was already applied is never run or edited again."""
    db.execute(
        """IF OBJECT_ID('schema_migrations') IS NULL
           CREATE TABLE schema_migrations (
               version     NVARCHAR(100) PRIMARY KEY,
               applied_at  DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
           )"""
    )
    db.commit()
    done = {row["version"] for row in db.execute("SELECT version FROM schema_migrations").fetchall()}
    for path in sorted(MIGRATIONS_DIR.glob("*.sql")):
        if path.name in done:
            continue
        db.execute(path.read_text())
        db.execute("INSERT INTO schema_migrations (version) VALUES (%s)", (path.name,))
        db.commit()
        print(f"applied migration {path.name}", flush=True)
