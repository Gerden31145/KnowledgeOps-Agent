ALTER TYPE "OutboxEventType" ADD VALUE 'GITHUB_PUSH_RECEIVED';

CREATE TABLE "webhook_deliveries" (
  "id" UUID NOT NULL,
  "event_type" VARCHAR(64) NOT NULL,
  "payload_hash" VARCHAR(64) NOT NULL,
  "status" VARCHAR(16) NOT NULL,
  "ignore_reason" VARCHAR(64),
  "payload" JSONB NOT NULL,
  "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "webhook_deliveries_status_check" CHECK (
    ("status" = 'ACCEPTED' AND "ignore_reason" IS NULL) OR
    ("status" = 'IGNORED' AND "ignore_reason" IS NOT NULL)
  )
);
