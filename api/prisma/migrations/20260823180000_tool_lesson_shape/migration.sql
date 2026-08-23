-- The learned SHAPE of an answer (BEA-1415): where the list is and what fields an item carries.
-- Paths and types only — never a value — so it works for the services whose answers are never kept.
ALTER TABLE "ToolLesson" ADD COLUMN "shape" TEXT;
