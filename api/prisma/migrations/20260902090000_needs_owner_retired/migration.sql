-- BEA-1596: "Needs you" has one source now — the review inbox (TeamUpdate.needsYou).
--
-- Reminder.needsOwner is retired. The column stays (no destructive change to a live table);
-- nothing reads or writes it after this ships. This one-off clears the stale flags left behind
-- (four live ghosts on the Dashboard on 2026-09-02) so no leftover reader can ever show them.
-- Safe to run more than once.
UPDATE "Reminder" SET "needsOwner" = 0 WHERE "needsOwner" = 1;
