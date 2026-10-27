CREATE TABLE "note_verification_executions" (
  "run_id" UUID NOT NULL,
  "claim_token" UUID NOT NULL,
  "run_version" INTEGER NOT NULL,
  "request_fingerprint" VARCHAR(64) NOT NULL,
  "configuration" JSONB NOT NULL,
  "deadline_at" TIMESTAMPTZ(3) NOT NULL,
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "pending_attempt" INTEGER,
  "accounting" JSONB NOT NULL,
  "result" JSONB,
  "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finished_at" TIMESTAMPTZ(3),
  CONSTRAINT "note_verification_executions_pkey" PRIMARY KEY ("run_id"),
  CONSTRAINT "note_verification_executions_run_fkey" FOREIGN KEY ("run_id") REFERENCES "agent_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "note_verification_execution_attempt_check" CHECK (
    "run_version" >= 0 AND "attempt_count" BETWEEN 0 AND 2 AND
    ("pending_attempt" IS NULL OR ("pending_attempt" = "attempt_count" AND "pending_attempt" > 0))
  ),
  CONSTRAINT "note_verification_execution_finish_check" CHECK (
    ("result" IS NULL AND "finished_at" IS NULL) OR
    ("result" IS NOT NULL AND "finished_at" IS NOT NULL AND "pending_attempt" IS NULL)
  )
);
