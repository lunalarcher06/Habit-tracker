-- Habits service, migration 002: the outfit the user's cat wears.
-- The users table already holds rows when this runs, so the new column is NOT NULL with a
-- default: SQL Server fills every existing row with 'none', so nobody has to be updated by hand.
-- No GO lines: the runner sends each file as a single batch.

ALTER TABLE users
    ADD outfit NVARCHAR(30) NOT NULL
        CONSTRAINT df_users_outfit DEFAULT 'none';
