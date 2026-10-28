ALTER TYPE "OutboxEventType" ADD VALUE 'ANSWER_VERIFICATION_REQUESTED';

CREATE TABLE "answer_submissions" (
  "id" UUID NOT NULL,
  "question_id" UUID NOT NULL,
  "request_id" UUID NOT NULL,
  "expected_task_version" INTEGER NOT NULL,
  "content" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "answer_submissions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "answer_submissions_question_id_fkey" FOREIGN KEY ("question_id") REFERENCES "follow_up_questions"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "answer_submissions_task_version_check" CHECK ("expected_task_version" >= 0),
  CONSTRAINT "answer_submissions_content_check" CHECK (char_length("content") BETWEEN 1 AND 8000)
);
CREATE UNIQUE INDEX "answer_submissions_question_id_request_id_key" ON "answer_submissions"("question_id", "request_id");

ALTER TABLE "agent_runs" ADD COLUMN "answer_submission_id" UUID;
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_answer_submission_id_fkey"
  FOREIGN KEY ("answer_submission_id") REFERENCES "answer_submissions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_answer_source_check"
  CHECK ("answer_submission_id" IS NULL OR ("kind" = 'ANSWER_VERIFICATION' AND "submission_id" IS NULL));
CREATE UNIQUE INDEX "agent_runs_one_initial_per_answer" ON "agent_runs"("answer_submission_id") WHERE "retry_of_run_id" IS NULL;
