-- Two SQL Server databases, each with their own separate login.
-- One-off setup, run by the db-init service in docker-compose.yml with sqlcmd.
-- Safe to run again: every step first checks whether it is already done.
-- The passwords come in as sqlcmd variables (-v), so none are stored in the repo.

-- Habits service: its own database and its own login
IF DB_ID('habits') IS NULL CREATE DATABASE habits;
GO
IF SUSER_ID('habits_user') IS NULL
    CREATE LOGIN habits_user WITH PASSWORD = '$(HABITS_DB_PASSWORD)', CHECK_POLICY = OFF;
ELSE
    ALTER LOGIN habits_user WITH PASSWORD = '$(HABITS_DB_PASSWORD)';
GO
USE habits;
GO
IF USER_ID('habits_user') IS NULL CREATE USER habits_user FOR LOGIN habits_user;
ALTER ROLE db_owner ADD MEMBER habits_user;   -- owner of its own database only (migrations create tables)
GO

-- Streaks service: its own database and its own login
USE master;
GO
IF DB_ID('streaks') IS NULL CREATE DATABASE streaks;
GO
IF SUSER_ID('streaks_user') IS NULL
    CREATE LOGIN streaks_user WITH PASSWORD = '$(STREAKS_DB_PASSWORD)', CHECK_POLICY = OFF;
ELSE
    ALTER LOGIN streaks_user WITH PASSWORD = '$(STREAKS_DB_PASSWORD)';
GO
USE streaks;
GO
IF USER_ID('streaks_user') IS NULL CREATE USER streaks_user FOR LOGIN streaks_user;
ALTER ROLE db_owner ADD MEMBER streaks_user;
GO
