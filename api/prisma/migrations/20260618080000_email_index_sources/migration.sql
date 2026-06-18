-- Index the Daily Email Brief + Email Requests (mandatory sections). (BEA-336)
ALTER TABLE "GmailBrief" ADD COLUMN "supermemoryId" TEXT;
ALTER TABLE "GmailBrief" ADD COLUMN "ragId" TEXT;
ALTER TABLE "GmailRequest" ADD COLUMN "supermemoryId" TEXT;
ALTER TABLE "GmailRequest" ADD COLUMN "ragId" TEXT;
