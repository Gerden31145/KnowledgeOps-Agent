CREATE TYPE "CourseExerciseSubmissionStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED');
ALTER TYPE "OutboxEventType" ADD VALUE 'COURSE_EXERCISE_REQUESTED';

CREATE TABLE "course_exercise_submissions" (
    "id" UUID NOT NULL,
    "exercise_set_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "fingerprint" CHAR(64) NOT NULL,
    "expected_task_version" INTEGER NOT NULL,
    "multiple_choice_answers" JSONB NOT NULL,
    "follow_up_answer" TEXT NOT NULL,
    "status" "CourseExerciseSubmissionStatus" NOT NULL DEFAULT 'QUEUED',
    "report" JSONB,
    "error_code" VARCHAR(64),
    "model_catalog_id" VARCHAR(100) NOT NULL,
    "model_provider" VARCHAR(64) NOT NULL,
    "model_name" VARCHAR(160) NOT NULL,
    "execution_version" INTEGER NOT NULL DEFAULT 0,
    "deadline_at" TIMESTAMPTZ(3),
    "completed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "course_exercise_submissions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "course_exercise_submissions_user_id_request_id_key"
ON "course_exercise_submissions"("user_id", "request_id");
CREATE INDEX "course_exercise_submissions_exercise_set_id_user_id_created_at_idx"
ON "course_exercise_submissions"("exercise_set_id", "user_id", "created_at");
CREATE INDEX "course_exercise_submissions_status_deadline_at_idx"
ON "course_exercise_submissions"("status", "deadline_at");

ALTER TABLE "course_exercise_submissions"
ADD CONSTRAINT "course_exercise_submissions_exercise_set_id_fkey"
FOREIGN KEY ("exercise_set_id") REFERENCES "exercise_sets"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "course_exercise_submissions"
ADD CONSTRAINT "course_exercise_submissions_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "users"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
