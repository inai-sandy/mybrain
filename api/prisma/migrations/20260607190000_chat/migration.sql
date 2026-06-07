-- Extend ChatSession for the memory-chat platform
ALTER TABLE "ChatSession" ADD COLUMN "scope" TEXT NOT NULL DEFAULT 'everything';
ALTER TABLE "ChatSession" ADD COLUMN "summary" TEXT;
ALTER TABLE "ChatSession" ADD COLUMN "pinned" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ChatSession" ADD COLUMN "lastMessageAt" DATETIME;

-- CreateTable
CREATE TABLE "ChatMessage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "sources" TEXT,
    "followups" TEXT,
    "starred" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "ChatMessage_sessionId_idx" ON "ChatMessage"("sessionId");

-- CreateTable
CREATE TABLE "ChatStar" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "messageId" TEXT NOT NULL,
    "sessionId" TEXT,
    "sessionTitle" TEXT,
    "scope" TEXT NOT NULL DEFAULT 'everything',
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "sources" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "ChatStar_messageId_key" ON "ChatStar"("messageId");
