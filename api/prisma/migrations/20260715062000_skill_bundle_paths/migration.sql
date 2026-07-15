-- "Install as one bundle" — store the sub-skill paths a bundle skill contains (BEA-979).
ALTER TABLE "Skill" ADD COLUMN "bundlePaths" TEXT;
