ALTER TABLE "webhook_deliveries"
  ADD COLUMN "evidence_attempt_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "evidence_last_attempt_at" TIMESTAMPTZ(3),
  ADD COLUMN "evidence_last_error_code" VARCHAR(64),
  ADD COLUMN "evidence_failed_at" TIMESTAMPTZ(3);

ALTER TABLE "webhook_deliveries"
  ADD CONSTRAINT "webhook_deliveries_evidence_attempt_count_check" CHECK ("evidence_attempt_count" >= 0),
  ADD CONSTRAINT "webhook_deliveries_evidence_failure_check" CHECK (
    "evidence_failed_at" IS NULL OR ("status" = 'ACCEPTED' AND "evidence_last_error_code" IS NOT NULL)
  );
