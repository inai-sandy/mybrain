-- Per-document chat: bind a chat session to one Item
ALTER TABLE "ChatSession" ADD COLUMN "docId" TEXT;
