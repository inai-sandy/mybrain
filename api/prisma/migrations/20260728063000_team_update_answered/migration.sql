-- BEA-1159: one message can claim several jobs; he rules on each, so remember which are answered.
ALTER TABLE "TeamUpdate" ADD COLUMN "answered" TEXT;
