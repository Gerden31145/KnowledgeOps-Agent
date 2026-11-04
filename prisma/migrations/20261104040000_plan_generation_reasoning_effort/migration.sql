-- Preserve provider-default behavior for existing runs; only new runs freeze the setting.
ALTER TABLE "plan_generation_runs"
  ADD COLUMN "model_reasoning_effort" VARCHAR(16),
  ADD CONSTRAINT "plan_generation_runs_reasoning_effort_check"
    CHECK ("model_reasoning_effort" IN ('low', 'high', 'max'));
