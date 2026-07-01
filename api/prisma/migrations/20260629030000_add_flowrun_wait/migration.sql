-- Durable "Ask me" pause for flow runs (Move B)
ALTER TABLE "FlowRun" ADD COLUMN "waitNodeId" TEXT;
ALTER TABLE "FlowRun" ADD COLUMN "waitQuestion" TEXT;
ALTER TABLE "FlowRun" ADD COLUMN "waitKind" TEXT;
ALTER TABLE "FlowRun" ADD COLUMN "waitOptions" TEXT NOT NULL DEFAULT '[]';
ALTER TABLE "FlowRun" ADD COLUMN "waitToken" TEXT;
