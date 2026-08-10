-- CreateEnum
CREATE TYPE "TaskType" AS ENUM ('MARKDOWN_NOTE');

-- CreateEnum
CREATE TYPE "AcceptanceCriterionType" AS ENUM ('FILE_CHANGED', 'SECTION_PRESENT', 'CONTENT_MINIMUM', 'SEMANTIC_CORRECTNESS', 'TOPIC_COVERAGE', 'EXPLANATION_QUALITY', 'FOLLOW_UP_ANSWER');

-- CreateEnum
CREATE TYPE "PlanGenerationRunState" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'TIMED_OUT');

-- CreateEnum
CREATE TYPE "OutboxEventType" AS ENUM ('PLAN_GENERATION_REQUESTED');

-- AlterTable
ALTER TABLE "plans" ADD COLUMN "generation_run_id" UUID;

-- AlterTable
ALTER TABLE "tasks"
ADD COLUMN "suggested_steps" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "type" "TaskType" NOT NULL DEFAULT 'MARKDOWN_NOTE';

-- AlterTable
ALTER TABLE "users" ADD COLUMN "preferred_model_id" VARCHAR(100);

-- Existing task graphs and every future graph reject a direct self dependency.
ALTER TABLE "task_dependencies"
ADD CONSTRAINT "task_dependencies_no_self_reference" CHECK ("task_id" <> "prerequisite_task_id");

-- CreateTable
CREATE TABLE "acceptance_criteria" (
    "id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "type" "AcceptanceCriterionType" NOT NULL,
    "description" TEXT NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT true,
    "position" INTEGER NOT NULL,
    "config" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "acceptance_criteria_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "acceptance_criteria_position_non_negative" CHECK ("position" >= 0)
);

-- CreateTable
CREATE TABLE "plan_generation_runs" (
    "id" UUID NOT NULL,
    "goal_id" UUID NOT NULL,
    "status" "PlanGenerationRunState" NOT NULL DEFAULT 'QUEUED',
    "retry_of_run_id" UUID,
    "model_catalog_id" VARCHAR(100) NOT NULL,
    "model_provider" VARCHAR(64) NOT NULL,
    "model_name" VARCHAR(160) NOT NULL,
    "prompt_version" VARCHAR(64) NOT NULL,
    "output_schema_version" VARCHAR(64) NOT NULL,
    "error_code" VARCHAR(64),
    "error_message" VARCHAR(500),
    "version" INTEGER NOT NULL DEFAULT 0,
    "deadline_at" TIMESTAMPTZ(3) NOT NULL,
    "queued_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "plan_generation_runs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "plan_generation_runs_deadline_after_queue" CHECK ("deadline_at" > "queued_at"),
    CONSTRAINT "plan_generation_runs_no_self_retry" CHECK ("retry_of_run_id" IS NULL OR "retry_of_run_id" <> "id")
);

-- CreateTable
CREATE TABLE "outbox_events" (
    "id" UUID NOT NULL,
    "type" "OutboxEventType" NOT NULL,
    "aggregate_id" UUID NOT NULL,
    "deduplication_key" VARCHAR(200) NOT NULL,
    "payload" JSONB NOT NULL,
    "schema_version" INTEGER NOT NULL DEFAULT 1,
    "available_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dispatched_at" TIMESTAMPTZ(3),
    "dispatch_attempt_count" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "outbox_events_dispatch_attempt_count_non_negative" CHECK ("dispatch_attempt_count" >= 0)
);

-- CreateIndex
CREATE UNIQUE INDEX "acceptance_criteria_task_id_position_key" ON "acceptance_criteria"("task_id", "position");

-- CreateIndex
CREATE INDEX "plan_generation_runs_goal_id_queued_at_idx" ON "plan_generation_runs"("goal_id", "queued_at");

-- CreateIndex
CREATE INDEX "plan_generation_runs_status_deadline_at_idx" ON "plan_generation_runs"("status", "deadline_at");

-- PostgreSQL is the final concurrency guard: two API processes cannot both
-- leave a QUEUED/RUNNING generation attempt for the same learning goal.
CREATE UNIQUE INDEX "plan_generation_runs_one_active_per_goal"
ON "plan_generation_runs"("goal_id")
WHERE ("status" IN ('QUEUED', 'RUNNING'));

-- CreateIndex
CREATE UNIQUE INDEX "outbox_events_deduplication_key_key" ON "outbox_events"("deduplication_key");

-- CreateIndex
CREATE INDEX "outbox_events_dispatched_at_available_at_idx" ON "outbox_events"("dispatched_at", "available_at");

-- CreateIndex
CREATE INDEX "outbox_events_type_aggregate_id_idx" ON "outbox_events"("type", "aggregate_id");

-- CreateIndex
CREATE UNIQUE INDEX "plans_generation_run_id_key" ON "plans"("generation_run_id");

-- AddForeignKey
ALTER TABLE "plans" ADD CONSTRAINT "plans_generation_run_id_fkey" FOREIGN KEY ("generation_run_id") REFERENCES "plan_generation_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "acceptance_criteria" ADD CONSTRAINT "acceptance_criteria_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_generation_runs" ADD CONSTRAINT "plan_generation_runs_goal_id_fkey" FOREIGN KEY ("goal_id") REFERENCES "learning_goals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_generation_runs" ADD CONSTRAINT "plan_generation_runs_retry_of_run_id_fkey" FOREIGN KEY ("retry_of_run_id") REFERENCES "plan_generation_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
