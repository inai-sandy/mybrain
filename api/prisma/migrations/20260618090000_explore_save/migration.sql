-- Saved Explore answers (separate from the index). (BEA-339)
CREATE TABLE "ExploreSave" (
  "id"        TEXT NOT NULL PRIMARY KEY,
  "question"  TEXT NOT NULL,
  "answer"    TEXT NOT NULL,
  "sources"   TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
