-- Documents a flow run produced (Agent↔Flow merge ④); JSON array of {id, slug, title}
ALTER TABLE "FlowRun" ADD COLUMN "documentIds" TEXT NOT NULL DEFAULT '[]';
