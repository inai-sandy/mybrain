-- Rediscover needs to know what the owner has actually looked at, so it can surface the
-- genuinely forgotten ones and stop suggesting what he just opened. (BEA-1048)
ALTER TABLE "Item" ADD COLUMN "lastOpenedAt" DATETIME;
