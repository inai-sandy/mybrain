-- People memory: who appears in the user's stories
CREATE TABLE "PersonMention" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "PersonMention_name_day_key" ON "PersonMention"("name", "day");
