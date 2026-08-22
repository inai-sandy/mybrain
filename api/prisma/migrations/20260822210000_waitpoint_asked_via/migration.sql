-- BEA-1392: where a question was SENT, so an owner's WhatsApp reply can only answer a question
-- WhatsApp itself asked. Additive and nullable: every existing waitpoint reads as "not asked on
-- WhatsApp", which is exactly what it was.

ALTER TABLE "Waitpoint" ADD COLUMN "askedVia" TEXT;
