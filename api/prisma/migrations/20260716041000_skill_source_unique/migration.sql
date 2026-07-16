-- One row per imported source — backs the "never duplicate" guarantee at the DB level (BEA-984).
-- NULLs are distinct in SQLite, so hand-created and bundle rows (skillPath NULL) are unaffected.
CREATE UNIQUE INDEX "Skill_sourceRepo_skillPath_key" ON "Skill"("sourceRepo", "skillPath");
