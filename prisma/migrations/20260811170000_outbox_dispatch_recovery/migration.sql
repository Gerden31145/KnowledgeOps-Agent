-- An event with an invalid version or payload cannot succeed after a Redis retry.
-- Keep it visible for diagnosis without letting it block later valid events.
ALTER TABLE "outbox_events"
ADD COLUMN "dead_lettered_at" TIMESTAMPTZ(3);

DROP INDEX "outbox_events_dispatched_at_available_at_idx";

CREATE INDEX "outbox_events_dispatched_at_dead_lettered_at_available_at_idx"
ON "outbox_events"("dispatched_at", "dead_lettered_at", "available_at");
