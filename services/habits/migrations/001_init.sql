-- Habits service, migration 001: the first schema (ported from the SQLite version).
-- No GO lines: the runner sends each file as a single batch.

CREATE TABLE users (
    id             INT IDENTITY(1,1) PRIMARY KEY,
    first_name     NVARCHAR(60)  NOT NULL,
    last_name      NVARCHAR(60)  NOT NULL,
    username       NVARCHAR(40)  NOT NULL UNIQUE,
    password_hash  NVARCHAR(255) NOT NULL,
    created_at     DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME()
);

CREATE TABLE habit_groups (
    id          INT IDENTITY(1,1) PRIMARY KEY,
    user_id     INT           NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name        NVARCHAR(60)  NOT NULL,
    position    INT           NOT NULL DEFAULT 0,
    created_at  DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME()
);

-- group_id has no ON DELETE SET NULL: SQL Server refuses two cascade paths from users
-- to habits (users -> habits and users -> habit_groups -> habits). delete_group()
-- sets group_id to NULL itself before it deletes the group.
CREATE TABLE habits (
    id                    INT IDENTITY(1,1) PRIMARY KEY,
    user_id               INT           NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    group_id              INT           NULL REFERENCES habit_groups(id),
    name                  NVARCHAR(100) NOT NULL,
    frequency             NVARCHAR(10)  NOT NULL DEFAULT 'daily',
    weekdays_mask         INT           NULL,
    target_count_per_day  INT           NOT NULL DEFAULT 1,
    archived              BIT           NOT NULL DEFAULT 0,
    created_at            DATE          NOT NULL DEFAULT CAST(SYSUTCDATETIME() AS DATE)
);

-- One row per habit per day; the day is done once count >= target_count_per_day.
CREATE TABLE checkins (
    id        INT IDENTITY(1,1) PRIMARY KEY,
    habit_id  INT  NOT NULL REFERENCES habits(id) ON DELETE CASCADE,
    date      DATE NOT NULL,
    count     INT  NOT NULL DEFAULT 0,
    note      NVARCHAR(500) NULL,
    CONSTRAINT uq_checkins_habit_date UNIQUE (habit_id, date)
);

CREATE INDEX idx_habits_user       ON habits(user_id);
CREATE INDEX idx_habits_group      ON habits(group_id);
CREATE INDEX idx_habit_groups_user ON habit_groups(user_id);
CREATE INDEX idx_checkins_habit    ON checkins(habit_id);
