-- Label-only index pointers for vault items (BEA-368). Store-doc ids only — never a secret.
ALTER TABLE "VaultItem" ADD COLUMN "supermemoryId" TEXT;
ALTER TABLE "VaultItem" ADD COLUMN "ragId" TEXT;
