-- Habits service, migration 003: when each check-in row was last changed.
-- The checkins table already holds rows when this runs (locally and on Azure), so it is done
-- in place and keeps every row:
--   1. add the column as NULL (existing rows are kept, the column is empty for them),
--   2. backfill existing rows with the start of their own day (the best value we have),
--   3. make it NOT NULL and give new rows a default.
-- Steps 2 and 3 are inside EXEC because SQL Server compiles the whole batch first, and the
-- new column does not exist yet at that point. No GO lines: the runner sends one batch.

ALTER TABLE checkins ADD updated_at DATETIME2 NULL;

EXEC('UPDATE checkins SET updated_at = CAST(date AS DATETIME2) WHERE updated_at IS NULL');
EXEC('ALTER TABLE checkins ALTER COLUMN updated_at DATETIME2 NOT NULL');
EXEC('ALTER TABLE checkins ADD CONSTRAINT df_checkins_updated_at DEFAULT SYSUTCDATETIME() FOR updated_at');
