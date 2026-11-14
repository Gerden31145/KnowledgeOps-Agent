ALTER TYPE "CourseQuestionStatus" ADD VALUE 'QUEUED';
ALTER TYPE "OutboxEventType" ADD VALUE 'COURSE_QUESTION_REQUESTED';

ALTER TABLE "course_questions"
ADD COLUMN "execution_version" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "deadline_at" TIMESTAMPTZ(3),
ALTER COLUMN "status" SET DEFAULT 'QUEUED';

UPDATE "course_questions"
SET "status" = 'FAILED',
    "error_code" = 'EXECUTION_INTERRUPTED',
    "completed_at" = CURRENT_TIMESTAMP
WHERE "status" = 'RUNNING';

CREATE INDEX "course_questions_status_deadline_at_idx"
ON "course_questions"("status", "deadline_at");
