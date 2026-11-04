-- Compatible with the R07 schema; outputs metadata/counts, never private content.
BEGIN READ ONLY;

SELECT migration_name,
       finished_at IS NOT NULL AS finished,
       rolled_back_at IS NOT NULL AS rolled_back
FROM "_prisma_migrations"
ORDER BY started_at;

SELECT status, count(*) FROM plan_generation_runs GROUP BY status;
SELECT kind, status, count(*) FROM agent_runs GROUP BY kind, status;

SELECT type,
       count(*) AS total,
       count(*) FILTER (
         WHERE dispatched_at IS NULL AND dead_lettered_at IS NULL
       ) AS pending,
       count(*) FILTER (WHERE dead_lettered_at IS NOT NULL) AS dead_lettered
FROM outbox_events
GROUP BY type;

SELECT pg_size_pretty(pg_database_size(current_database())) AS database_size;

COMMIT;
