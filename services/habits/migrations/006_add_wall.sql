-- Habits service, migration 006: the colour the user picked for the cat's room on their first day
-- (cream, pink or sage). The users table already holds rows; they all start as NULL, which the UI
-- reads as "not chosen yet" and asks once. No GO lines: the runner sends one batch.

ALTER TABLE users ADD wall NVARCHAR(20) NULL;
