ALTER TABLE "agent_runs" ADD COLUMN "deadline_at" TIMESTAMPTZ(3), ADD COLUMN "execution_configuration" JSONB;
CREATE TABLE "verification_reports" (
  "id" UUID NOT NULL,
  "run_id" UUID NOT NULL,
  "body" JSONB NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "verification_reports_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "verification_reports_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "agent_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "verification_reports_run_id_key" ON "verification_reports"("run_id");
