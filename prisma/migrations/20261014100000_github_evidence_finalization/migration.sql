ALTER TYPE "OutboxEventType" ADD VALUE 'NOTE_VERIFICATION_REQUESTED';

CREATE TABLE "submissions" (
  "id" UUID NOT NULL,
  "repository_id" UUID NOT NULL,
  "task_id" UUID NOT NULL,
  "task_version" INTEGER NOT NULL,
  "before_commit_sha" VARCHAR(40) NOT NULL,
  "after_commit_sha" VARCHAR(40) NOT NULL,
  "target_path" VARCHAR(1024) NOT NULL,
  "workflow_version" VARCHAR(64) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "submissions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "submissions_repository_id_fkey" FOREIGN KEY ("repository_id") REFERENCES "repositories"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "submissions_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "submissions_task_version_check" CHECK ("task_version" >= 0)
);
CREATE UNIQUE INDEX "submissions_note_business_key" ON "submissions"("repository_id", "task_id", "after_commit_sha", "workflow_version");
CREATE INDEX "submissions_task_id_created_at_idx" ON "submissions"("task_id", "created_at");

CREATE TABLE "evidence" (
  "id" UUID NOT NULL,
  "submission_id" UUID NOT NULL,
  "change" VARCHAR(16) NOT NULL,
  "previous_path" VARCHAR(1024),
  "source_commit_sha" VARCHAR(40) NOT NULL,
  "content" TEXT NOT NULL,
  "content_hash" VARCHAR(64) NOT NULL,
  "line_count" INTEGER NOT NULL,
  "diff" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "evidence_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "evidence_submission_id_fkey" FOREIGN KEY ("submission_id") REFERENCES "submissions"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "evidence_change_check" CHECK ("change" IN ('added', 'modified', 'removed', 'renamed')),
  CONSTRAINT "evidence_line_count_check" CHECK ("line_count" >= 0)
);
CREATE UNIQUE INDEX "evidence_submission_id_key" ON "evidence"("submission_id");

ALTER TABLE "agent_runs" ADD COLUMN "submission_id" UUID, ADD COLUMN "expected_task_version" INTEGER;
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_submission_id_fkey" FOREIGN KEY ("submission_id") REFERENCES "submissions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_expected_task_version_check" CHECK ("expected_task_version" IS NULL OR "expected_task_version" >= 0);
CREATE UNIQUE INDEX "agent_runs_one_initial_per_submission" ON "agent_runs"("submission_id") WHERE ("retry_of_run_id" IS NULL);

ALTER TABLE "webhook_deliveries" ADD COLUMN "processed_at" TIMESTAMPTZ(3), ADD COLUMN "submission_id" UUID, ADD COLUMN "agent_run_id" UUID;
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_submission_id_fkey" FOREIGN KEY ("submission_id") REFERENCES "submissions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_agent_run_id_fkey" FOREIGN KEY ("agent_run_id") REFERENCES "agent_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "webhook_deliveries" DROP CONSTRAINT "webhook_deliveries_status_check";
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_status_check" CHECK (
  ("status" = 'ACCEPTED' AND "ignore_reason" IS NULL AND "processed_at" IS NULL AND "submission_id" IS NULL AND "agent_run_id" IS NULL) OR
  ("status" = 'IGNORED' AND "ignore_reason" IS NOT NULL AND "submission_id" IS NULL AND "agent_run_id" IS NULL) OR
  ("status" = 'PROCESSED' AND "ignore_reason" IS NULL AND "processed_at" IS NOT NULL AND "submission_id" IS NOT NULL)
);
