CREATE TABLE "follow_up_questions" (
  "id" UUID NOT NULL,
  "report_id" UUID NOT NULL,
  "body" JSONB NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "follow_up_questions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "follow_up_questions_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "verification_reports"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "follow_up_questions_report_id_key" ON "follow_up_questions"("report_id");
