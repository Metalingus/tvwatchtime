-- Add a total order without dropping or replaying any existing delivery.
CREATE SEQUENCE "commsuni_outbox_sequence_seq";
ALTER TABLE "commsuni_outbox" ADD COLUMN "sequence" BIGINT;
WITH ordered AS (
  SELECT "id", ROW_NUMBER() OVER (ORDER BY "created_at", "id") AS n FROM "commsuni_outbox"
)
UPDATE "commsuni_outbox" AS o SET "sequence" = ordered.n FROM ordered WHERE o."id" = ordered."id";
SELECT setval('"commsuni_outbox_sequence_seq"',
  COALESCE((SELECT MAX("sequence") FROM "commsuni_outbox"), 0) + 1, false);
ALTER SEQUENCE "commsuni_outbox_sequence_seq" OWNED BY "commsuni_outbox"."sequence";
ALTER TABLE "commsuni_outbox" ALTER COLUMN "sequence" SET DEFAULT nextval('"commsuni_outbox_sequence_seq"');
ALTER TABLE "commsuni_outbox" ALTER COLUMN "sequence" SET NOT NULL;
CREATE UNIQUE INDEX "commsuni_outbox_sequence_key" ON "commsuni_outbox"("sequence");
