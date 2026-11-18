-- Streaks service, migration 002: milestones now unlock room items for the cat (3 to 100 days)
-- and outfits only for the three longest streaks (150, 200, 365 days).
-- The milestones table already holds rows, so they are updated in place: every milestone keeps
-- its user, habit, length and date, and only gets the name of its new reward.
-- No GO lines: the runner sends one batch.

UPDATE milestones
SET item_unlocked = CASE streak_length
    WHEN 3   THEN 'yarn'
    WHEN 7   THEN 'bowl'
    WHEN 14  THEN 'scratcher'
    WHEN 21  THEN 'bed'
    WHEN 30  THEN 'plant'
    WHEN 45  THEN 'rug'
    WHEN 60  THEN 'window'
    WHEN 90  THEN 'tree'
    WHEN 100 THEN 'fishtank'
    WHEN 150 THEN 'headphones'
    WHEN 200 THEN 'cool'
    WHEN 365 THEN 'royal'
    ELSE item_unlocked
END;
