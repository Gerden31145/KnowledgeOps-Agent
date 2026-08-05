-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "PlanStatus" AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED', 'COMPLETED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "TaskState" AS ENUM ('BLOCKED', 'READY', 'IN_PROGRESS', 'VERIFYING', 'NEEDS_REVISION', 'NEEDS_EVIDENCE', 'PASSED');

-- CreateEnum
CREATE TYPE "AgentRunKind" AS ENUM ('NOTE_VERIFICATION', 'ANSWER_VERIFICATION');

-- CreateEnum
CREATE TYPE "AgentRunState" AS ENUM ('QUEUED', 'RUNNING', 'CANCEL_REQUESTED', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "github_user_id" TEXT,
    "github_login" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Shanghai',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "learning_goals" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "title" VARCHAR(160) NOT NULL,
    "current_level" VARCHAR(500) NOT NULL,
    "deadline" DATE NOT NULL,
    "weekly_minutes" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "learning_goals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plans" (
    "id" UUID NOT NULL,
    "goal_id" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" "PlanStatus" NOT NULL DEFAULT 'DRAFT',
    "confirmed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stages" (
    "id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "title" VARCHAR(160) NOT NULL,
    "position" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "stages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tasks" (
    "id" UUID NOT NULL,
    "stage_id" UUID NOT NULL,
    "title" VARCHAR(160) NOT NULL,
    "description" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "estimated_minutes" INTEGER NOT NULL,
    "target_path" VARCHAR(1024),
    "state" "TaskState" NOT NULL DEFAULT 'BLOCKED',
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_dependencies" (
    "task_id" UUID NOT NULL,
    "prerequisite_task_id" UUID NOT NULL,

    CONSTRAINT "task_dependencies_pkey" PRIMARY KEY ("task_id","prerequisite_task_id")
);

-- CreateTable
CREATE TABLE "agent_runs" (
    "id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "kind" "AgentRunKind" NOT NULL,
    "status" "AgentRunState" NOT NULL DEFAULT 'QUEUED',
    "task_state_before_run" "TaskState" NOT NULL,
    "retry_of_run_id" UUID,
    "workflow_version" VARCHAR(64) NOT NULL,
    "error_code" VARCHAR(64),
    "version" INTEGER NOT NULL DEFAULT 0,
    "queued_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "agent_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_github_user_id_key" ON "users"("github_user_id");

-- CreateIndex
CREATE INDEX "learning_goals_user_id_created_at_idx" ON "learning_goals"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "plans_status_idx" ON "plans"("status");

-- CreateIndex
CREATE UNIQUE INDEX "plans_goal_id_version_key" ON "plans"("goal_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "stages_plan_id_position_key" ON "stages"("plan_id", "position");

-- CreateIndex
CREATE INDEX "tasks_state_updated_at_idx" ON "tasks"("state", "updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "tasks_stage_id_position_key" ON "tasks"("stage_id", "position");

-- CreateIndex
CREATE INDEX "task_dependencies_prerequisite_task_id_idx" ON "task_dependencies"("prerequisite_task_id");

-- CreateIndex
CREATE INDEX "agent_runs_task_id_queued_at_idx" ON "agent_runs"("task_id", "queued_at");

-- CreateIndex
CREATE INDEX "agent_runs_status_queued_at_idx" ON "agent_runs"("status", "queued_at");

-- AddForeignKey
ALTER TABLE "learning_goals" ADD CONSTRAINT "learning_goals_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plans" ADD CONSTRAINT "plans_goal_id_fkey" FOREIGN KEY ("goal_id") REFERENCES "learning_goals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stages" ADD CONSTRAINT "stages_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_stage_id_fkey" FOREIGN KEY ("stage_id") REFERENCES "stages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_prerequisite_task_id_fkey" FOREIGN KEY ("prerequisite_task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_retry_of_run_id_fkey" FOREIGN KEY ("retry_of_run_id") REFERENCES "agent_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
