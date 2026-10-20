-- 保留已有 Diff 证据；单点全文快照显式区分“无 Diff”与“空 Diff”。
ALTER TABLE "evidence" ADD COLUMN "mode" VARCHAR(16) NOT NULL DEFAULT 'DIFF';
ALTER TABLE "evidence" ALTER COLUMN "change" DROP NOT NULL;
ALTER TABLE "evidence" ALTER COLUMN "diff" DROP NOT NULL;
ALTER TABLE "evidence" DROP CONSTRAINT "evidence_change_check";
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_mode_check" CHECK (
  ("mode" = 'DIFF' AND "change" IS NOT NULL AND "change" IN ('added', 'modified', 'removed', 'renamed') AND "diff" IS NOT NULL) OR
  ("mode" = 'SNAPSHOT' AND "change" IS NULL AND "diff" IS NULL AND "previous_path" IS NULL)
);
