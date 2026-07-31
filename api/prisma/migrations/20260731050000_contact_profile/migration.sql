-- BEA-1216: the weekly character profile — one living row per contact, rewritten in place.
CREATE TABLE "ContactProfile" (
    "contactId" TEXT NOT NULL PRIMARY KEY,
    "text" TEXT NOT NULL,
    "weekStart" TEXT NOT NULL,
    "supermemoryId" TEXT,
    "ragId" TEXT,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ContactProfile_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
