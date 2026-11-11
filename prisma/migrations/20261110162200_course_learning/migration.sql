CREATE TYPE "CourseStatus" AS ENUM ('PENDING', 'GENERATING', 'READY', 'FAILED');
CREATE TYPE "CourseKnowledgeRole" AS ENUM ('TEACH', 'REVIEW');

ALTER TYPE "TaskType" ADD VALUE 'COURSE';
ALTER TYPE "OutboxEventType" ADD VALUE 'COURSE_GENERATION_REQUESTED';

CREATE TABLE "courses" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "task_id" UUID NOT NULL,
    "status" "CourseStatus" NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "courses_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "course_generation_runs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "course_id" UUID NOT NULL,
    "status" "PlanGenerationRunState" NOT NULL DEFAULT 'QUEUED',
    "retry_of_run_id" UUID,
    "model_catalog_id" VARCHAR(100) NOT NULL,
    "model_provider" VARCHAR(64) NOT NULL,
    "model_name" VARCHAR(160) NOT NULL,
    "model_reasoning_effort" VARCHAR(16),
    "prompt_version" VARCHAR(64) NOT NULL,
    "output_schema_version" VARCHAR(64) NOT NULL,
    "profile_snapshot" JSONB NOT NULL DEFAULT '[]',
    "error_code" VARCHAR(64),
    "error_message" VARCHAR(500),
    "version" INTEGER NOT NULL DEFAULT 0,
    "deadline_at" TIMESTAMPTZ(3) NOT NULL,
    "queued_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "course_generation_runs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "course_versions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "course_id" UUID NOT NULL,
    "generation_run_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "content" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "course_versions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "exercise_sets" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "course_version_id" UUID NOT NULL,
    "body" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "exercise_sets_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "knowledge_points" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "plan_id" UUID NOT NULL,
    "key" VARCHAR(64) NOT NULL,
    "title" VARCHAR(120) NOT NULL,
    "description" VARCHAR(500) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "knowledge_points_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "course_knowledge_points" (
    "course_id" UUID NOT NULL,
    "knowledge_point_id" UUID NOT NULL,
    "role" "CourseKnowledgeRole" NOT NULL DEFAULT 'TEACH',
    CONSTRAINT "course_knowledge_points_pkey" PRIMARY KEY ("course_id", "knowledge_point_id")
);

CREATE UNIQUE INDEX "courses_task_id_key" ON "courses"("task_id");
CREATE INDEX "courses_status_idx" ON "courses"("status");
CREATE INDEX "course_generation_runs_course_id_queued_at_idx" ON "course_generation_runs"("course_id", "queued_at");
CREATE INDEX "course_generation_runs_status_deadline_at_idx" ON "course_generation_runs"("status", "deadline_at");
CREATE UNIQUE INDEX "course_generation_runs_one_active_per_course" ON "course_generation_runs"("course_id") WHERE status = ANY (ARRAY['QUEUED'::"PlanGenerationRunState", 'RUNNING'::"PlanGenerationRunState"]);
CREATE UNIQUE INDEX "course_versions_generation_run_id_key" ON "course_versions"("generation_run_id");
CREATE UNIQUE INDEX "course_versions_course_id_version_key" ON "course_versions"("course_id", "version");
CREATE UNIQUE INDEX "exercise_sets_course_version_id_key" ON "exercise_sets"("course_version_id");
CREATE UNIQUE INDEX "knowledge_points_plan_id_key_key" ON "knowledge_points"("plan_id", "key");
CREATE INDEX "course_knowledge_points_knowledge_point_id_idx" ON "course_knowledge_points"("knowledge_point_id");

ALTER TABLE "courses" ADD CONSTRAINT "courses_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "course_generation_runs" ADD CONSTRAINT "course_generation_runs_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "courses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "course_generation_runs" ADD CONSTRAINT "course_generation_runs_retry_of_run_id_fkey" FOREIGN KEY ("retry_of_run_id") REFERENCES "course_generation_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "course_versions" ADD CONSTRAINT "course_versions_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "courses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "course_versions" ADD CONSTRAINT "course_versions_generation_run_id_fkey" FOREIGN KEY ("generation_run_id") REFERENCES "course_generation_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "exercise_sets" ADD CONSTRAINT "exercise_sets_course_version_id_fkey" FOREIGN KEY ("course_version_id") REFERENCES "course_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "knowledge_points" ADD CONSTRAINT "knowledge_points_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "course_knowledge_points" ADD CONSTRAINT "course_knowledge_points_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "courses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "course_knowledge_points" ADD CONSTRAINT "course_knowledge_points_knowledge_point_id_fkey" FOREIGN KEY ("knowledge_point_id") REFERENCES "knowledge_points"("id") ON DELETE CASCADE ON UPDATE CASCADE;
