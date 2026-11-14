-- CreateEnum
CREATE TYPE "CourseQuestionDepth" AS ENUM ('QUICK', 'CONTEXTUAL', 'DEEP');

-- CreateEnum
CREATE TYPE "CourseQuestionStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'FAILED');

-- AlterTable
ALTER TABLE "course_generation_runs" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "course_versions" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "courses" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "exercise_sets" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "knowledge_points" ALTER COLUMN "id" DROP DEFAULT;

-- CreateTable
CREATE TABLE "course_questions" (
    "id" UUID NOT NULL,
    "course_version_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "fingerprint" CHAR(64) NOT NULL,
    "section_id" VARCHAR(64) NOT NULL,
    "selected_text" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "depth" "CourseQuestionDepth" NOT NULL,
    "status" "CourseQuestionStatus" NOT NULL DEFAULT 'RUNNING',
    "answer" TEXT,
    "error_code" VARCHAR(64),
    "model_catalog_id" VARCHAR(100) NOT NULL,
    "model_provider" VARCHAR(64) NOT NULL,
    "model_name" VARCHAR(160) NOT NULL,
    "completed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "course_questions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "course_questions_course_version_id_user_id_created_at_idx" ON "course_questions"("course_version_id", "user_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "course_questions_user_id_request_id_key" ON "course_questions"("user_id", "request_id");

-- AddForeignKey
ALTER TABLE "course_questions" ADD CONSTRAINT "course_questions_course_version_id_fkey" FOREIGN KEY ("course_version_id") REFERENCES "course_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "course_questions" ADD CONSTRAINT "course_questions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
