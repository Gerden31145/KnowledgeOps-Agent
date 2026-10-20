ALTER TYPE "OutboxEventType" ADD VALUE 'GITHUB_EVIDENCE_RETRY_REQUESTED';
ALTER TABLE "webhook_deliveries" ADD COLUMN "evidence_retry_event_id" UUID;
