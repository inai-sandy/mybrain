-- Source tracking / pack grouping for skills (BEA-977) — the "lock model" for update-without-duplicate.
ALTER TABLE "Skill" ADD COLUMN "sourceRepo" TEXT;
ALTER TABLE "Skill" ADD COLUMN "sourceRef" TEXT;
ALTER TABLE "Skill" ADD COLUMN "skillPath" TEXT;
ALTER TABLE "Skill" ADD COLUMN "sourceUrl" TEXT;
ALTER TABLE "Skill" ADD COLUMN "folderHash" TEXT;
ALTER TABLE "Skill" ADD COLUMN "packId" TEXT;
ALTER TABLE "Skill" ADD COLUMN "packName" TEXT;
ALTER TABLE "Skill" ADD COLUMN "sourceUpdatedAt" DATETIME;
