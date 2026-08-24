-- BEA-1461: the exact parts box a worker was compiled against.
--
-- `kit` holds the MAJOR, which only moves when the kit breaks something — so it stayed on "1" when
-- the tools were opened (BEA-1457, an additive change) and a worker built the day before looked
-- perfectly current while having none of the new doors. This is a hash of the kit's own contents,
-- so it moves whenever anybody edits it and nobody has to remember to bump a number.
--
-- Nullable on purpose: every existing row predates the column, and null is read as "older than the
-- server's", which is exactly what those workers are.
ALTER TABLE "WorkerBuild" ADD COLUMN "kitRev" TEXT;
