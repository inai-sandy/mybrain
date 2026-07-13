-- CreateTable
CREATE TABLE "Recording" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT,
    "startedAt" DATETIME NOT NULL,
    "endedAt" DATETIME,
    "seconds" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'recording',
    "source" TEXT NOT NULL DEFAULT 'emo-cam',
    "bytes" INTEGER NOT NULL DEFAULT 0,
    "day" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "RecordingChunk" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "recordingId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "seconds" INTEGER NOT NULL DEFAULT 0,
    "bytes" INTEGER NOT NULL DEFAULT 0,
    "path" TEXT NOT NULL,
    "startSec" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RecordingChunk_recordingId_fkey" FOREIGN KEY ("recordingId") REFERENCES "Recording" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RecordingMark" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "recordingId" TEXT NOT NULL,
    "atSeconds" INTEGER NOT NULL,
    "windowSec" INTEGER NOT NULL DEFAULT 120,
    "kind" TEXT NOT NULL DEFAULT 'tap',
    "wallTime" DATETIME NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "transcript" TEXT,
    "cardId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RecordingMark_recordingId_fkey" FOREIGN KEY ("recordingId") REFERENCES "Recording" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "Recording_day_idx" ON "Recording"("day");
CREATE INDEX "Recording_status_idx" ON "Recording"("status");
CREATE UNIQUE INDEX "RecordingChunk_recordingId_seq_key" ON "RecordingChunk"("recordingId", "seq");
CREATE INDEX "RecordingMark_recordingId_idx" ON "RecordingMark"("recordingId");
CREATE INDEX "RecordingMark_status_idx" ON "RecordingMark"("status");
