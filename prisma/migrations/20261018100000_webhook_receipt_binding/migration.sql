-- 接收归属与是否创建取证待办分离；不创建虚假 Outbox/任务或回填当前任务。
ALTER TABLE "webhook_deliveries" ADD COLUMN "received_repository_id" UUID;

ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_received_repository_id_fkey"
  FOREIGN KEY ("received_repository_id") REFERENCES "repositories"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "webhook_deliveries_received_repository_id_received_at_id_idx"
  ON "webhook_deliveries"("received_repository_id", "received_at", "id");

-- 仅使用旧 v2 Outbox 已冻结的绑定/用户，且核对原 Push 的安装、仓库及分支。
-- 不能按今天的活动绑定认领过去的通知；无上下文的历史 IGNORED/ping 保持 null。
UPDATE "webhook_deliveries" AS d
SET "received_repository_id" = r."id"
FROM "outbox_events" AS o
JOIN "repositories" AS r
  ON r."id"::text = o."payload" #>> '{binding,repositoryId}'
  AND r."user_id"::text = o."payload" #>> '{binding,userId}'
WHERE d."received_repository_id" IS NULL
  AND d."event_type" = 'push'
  AND o."type" = 'GITHUB_PUSH_RECEIVED'
  AND o."schema_version" = 2
  AND o."aggregate_id" = d."id"
  AND o."deduplication_key" = 'github-push-received-' || d."id"::text
  AND o."payload" ->> 'deliveryId' = d."id"::text
  AND d."payload" #>> '{installation,id}' = r."installation_id"
  AND d."payload" #>> '{repository,id}' = r."github_repository_id"
  AND d."payload" ->> 'ref' = 'refs/heads/' || r."branch";
