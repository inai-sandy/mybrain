-- BEA-1101: agent/flow outputs are never auto-indexed; the flag gates the memory reconcile.
ALTER TABLE "Document" ADD COLUMN "noIndex" BOOLEAN NOT NULL DEFAULT false;
