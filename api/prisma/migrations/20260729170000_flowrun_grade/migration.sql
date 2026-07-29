-- BEA-1191: a flow run's verdict against the job's Outcome. Deep runs and every voice job go
-- through flows, so without this they finished with no pass/fail at all.
ALTER TABLE "FlowRun" ADD COLUMN "grade" TEXT;
