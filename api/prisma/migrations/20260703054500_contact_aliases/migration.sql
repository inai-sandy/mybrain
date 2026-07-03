-- AddColumn
ALTER TABLE "Contact" ADD COLUMN "aliases" TEXT NOT NULL DEFAULT '[]';
