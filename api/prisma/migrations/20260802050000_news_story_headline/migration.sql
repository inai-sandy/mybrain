-- BEA-1267: a short written headline per story, produced by the same section call that writes the
-- prose (so it costs no extra engine turn). Null until an edition is written and after an engine
-- failure — the page falls back to the story's first sentence.
--
-- First migration since BEA-1262 fixed the AgentArea drift: Prisma generated this clean, with no
-- RedefineTables block to strip by hand. That was the whole point of doing it.
ALTER TABLE "NewsStory" ADD COLUMN "headline" TEXT;
