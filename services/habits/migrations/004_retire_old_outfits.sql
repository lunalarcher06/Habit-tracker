-- Habits service, migration 004: only three outfits are left (headphones, cool, royal, for the
-- 150, 200 and 365-day milestones); the other milestones now unlock things for the cat's room.
-- A user who was wearing one of the retired outfits keeps their account and everything else;
-- only the outfit goes back to 'none'. No GO lines: the runner sends one batch.

UPDATE users
SET outfit = 'none'
WHERE outfit NOT IN ('none', 'headphones', 'cool', 'royal');
