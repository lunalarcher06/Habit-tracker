-- Streaks service, migration 001: the milestones table.
-- user_id and habit_id are plain IDs from the Habits service, so there is no
-- foreign key across the seam (ADR 6).
CREATE TABLE milestones (
    id             INT IDENTITY(1,1) PRIMARY KEY,
    user_id        INT           NOT NULL,
    habit_id       INT           NOT NULL,
    streak_length  INT           NOT NULL,
    item_unlocked  NVARCHAR(100) NULL,
    achieved_on    DATE          NOT NULL,
    CONSTRAINT uq_milestones_habit_streak UNIQUE (habit_id, streak_length)
);

CREATE INDEX idx_milestones_user ON milestones(user_id);
