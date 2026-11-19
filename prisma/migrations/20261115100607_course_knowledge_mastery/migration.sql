-- CreateEnum
CREATE TYPE "KnowledgeMasteryLevel" AS ENUM ('UNKNOWN', 'WEAK', 'DEVELOPING', 'MASTERED');

-- CreateEnum
CREATE TYPE "CourseKnowledgeEvidenceKind" AS ENUM ('MULTIPLE_CHOICE', 'FOLLOW_UP');

-- CreateTable
CREATE TABLE "course_knowledge_evidence" (
    "id" UUID NOT NULL,
    "submission_id" UUID NOT NULL,
    "knowledge_point_id" UUID NOT NULL,
    "question_id" VARCHAR(64) NOT NULL,
    "kind" "CourseKnowledgeEvidenceKind" NOT NULL,
    "score" INTEGER NOT NULL,
    "misconception_tags" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "course_knowledge_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_masteries" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "knowledge_point_id" UUID NOT NULL,
    "level" "KnowledgeMasteryLevel" NOT NULL,
    "score" INTEGER NOT NULL,
    "evidence_count" INTEGER NOT NULL,
    "misconception_tags" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "knowledge_masteries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "course_knowledge_evidence_knowledge_point_id_created_at_idx" ON "course_knowledge_evidence"("knowledge_point_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "course_knowledge_evidence_submission_id_knowledge_point_id__key" ON "course_knowledge_evidence"("submission_id", "knowledge_point_id", "question_id");

-- CreateIndex
CREATE INDEX "knowledge_masteries_knowledge_point_id_level_idx" ON "knowledge_masteries"("knowledge_point_id", "level");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_masteries_user_id_knowledge_point_id_key" ON "knowledge_masteries"("user_id", "knowledge_point_id");

-- AddForeignKey
ALTER TABLE "course_knowledge_evidence" ADD CONSTRAINT "course_knowledge_evidence_submission_id_fkey" FOREIGN KEY ("submission_id") REFERENCES "course_exercise_submissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "course_knowledge_evidence" ADD CONSTRAINT "course_knowledge_evidence_knowledge_point_id_fkey" FOREIGN KEY ("knowledge_point_id") REFERENCES "knowledge_points"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_masteries" ADD CONSTRAINT "knowledge_masteries_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_masteries" ADD CONSTRAINT "knowledge_masteries_knowledge_point_id_fkey" FOREIGN KEY ("knowledge_point_id") REFERENCES "knowledge_points"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "course_exercise_submissions_exercise_set_id_user_id_created_at_" RENAME TO "course_exercise_submissions_exercise_set_id_user_id_created_idx";
