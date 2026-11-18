-- Habits service, migration 005: which earned items the user put in the cat's room.
-- A comma-separated list of item names (e.g. 'bed,plant,yarn'), at most 5.
-- NULL means the user has not chosen yet: the UI then shows the newest items they earned.
-- The users table already holds rows; they all start as NULL, so nothing else changes for them.
-- No GO lines: the runner sends one batch.

ALTER TABLE users ADD room NVARCHAR(200) NULL;
