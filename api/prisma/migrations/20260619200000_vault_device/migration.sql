-- Vault biometric/passkey devices (WebAuthn PRF). Stores only the wrapped vault key. (BEA-352)
CREATE TABLE "VaultDevice" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "credentialId" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "wrap" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "VaultDevice_credentialId_key" ON "VaultDevice"("credentialId");
