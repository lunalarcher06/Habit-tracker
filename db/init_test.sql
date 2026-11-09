--Database for tests, they never touch real data.
-- Run it after init.sql (README). 
USE master;
GO
IF DB_ID('habits_test') IS NULL CREATE DATABASE habits_test;
IF DB_ID('streaks_test') IS NULL CREATE DATABASE streaks_test;
GO
USE habits_test;
GO
IF USER_ID('habits_user') IS NULL CREATE USER habits_user FOR LOGIN habits_user;
ALTER ROLE db_owner ADD MEMBER habits_user;
GO
USE streaks_test;
GO
IF USER_ID('streaks_user') IS NULL CREATE USER streaks_user FOR LOGIN streaks_user;
ALTER ROLE db_owner ADD MEMBER streaks_user;
GO
