CREATE EXTENSION IF NOT EXISTS vector;
ALTER TABLE "patterns" ADD COLUMN "embedding" vector(256);
