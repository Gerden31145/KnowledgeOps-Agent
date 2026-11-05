#!/usr/bin/env bash
# Reuses CD01; intended only for the disposable GitHub-hosted images job.
set -euo pipefail

[[ "${GITHUB_ACTIONS:-}" == true && "${RUNNER_ENVIRONMENT:-}" == github-hosted ]]
[[ "${COMPOSE_PROJECT_NAME:-}" == "knowledgeops-ci-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}" ]]
compose=(docker compose --env-file deploy/.env.cd01)

"${compose[@]}" config --quiet
"${compose[@]}" up -d --wait --wait-timeout 120 postgres redis
"${compose[@]}" run --rm --no-deps -T --pull never migrate
"${compose[@]}" up -d --no-build --pull never --wait --wait-timeout 120 api web worker
curl --noproxy '*' --max-time 10 -fsS http://127.0.0.1:14000/health/ready
curl --noproxy '*' --max-time 10 -fsS -o /dev/null http://127.0.0.1:13200/

seed=$("${compose[@]}" run --rm --no-deps -T --pull never worker \
  node --input-type=module - seed < tests/deploy/cd01-fixture.mjs)
run_id=$(printf '%s' "$seed" | node --input-type=module -e '
  import assert from "node:assert/strict";
  import { readFileSync } from "node:fs";
  const result = JSON.parse(readFileSync(0, "utf8"));
  assert.equal(result.event, "cd01-seeded");
  assert.match(result.runId, /^[a-f\d-]{36}$/i);
  console.log(result.runId);
')
"${compose[@]}" run --rm --no-deps -T --pull never worker \
  node --input-type=module - check "$run_id" < tests/deploy/cd01-fixture.mjs \
  > "$RUNNER_TEMP/cd02-before.json"

"${compose[@]}" stop api web worker
for service in api web worker; do
  container_id=$("${compose[@]}" ps -a -q "$service")
  docker inspect --format '{{json .State}}' "$container_id" | node --input-type=module -e '
    import assert from "node:assert/strict";
    import { readFileSync } from "node:fs";
    const state = JSON.parse(readFileSync(0, "utf8"));
    assert.equal(state.Running, false);
    assert.equal(state.OOMKilled, false);
    assert.ok([0, 143].includes(state.ExitCode), `Unexpected exit: ${state.ExitCode}`);
  '
done

"${compose[@]}" up -d --force-recreate --no-build --pull never --wait --wait-timeout 120 postgres redis
# Keep the model's observed request counter while recreating the application containers.
"${compose[@]}" up -d --no-deps --force-recreate --no-build --pull never --wait --wait-timeout 120 api web worker
"${compose[@]}" run --rm --no-deps -T --pull never worker \
  node --input-type=module - check "$run_id" < tests/deploy/cd01-fixture.mjs \
  > "$RUNNER_TEMP/cd02-after.json"

node --input-type=module <<'NODE'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const directory = process.env.RUNNER_TEMP
const before = JSON.parse(readFileSync(join(directory, 'cd02-before.json'), 'utf8'))
const after = JSON.parse(readFileSync(join(directory, 'cd02-after.json'), 'utf8'))
assert.deepEqual(after, before, 'Recreation must preserve the same verified business result')
const receipt = {
  event: 'cd02-smoke-verified',
  commit: process.env.GITHUB_SHA,
  runId: process.env.GITHUB_RUN_ID,
  attempt: process.env.GITHUB_RUN_ATTEMPT,
  before,
  after,
}
writeFileSync(join(directory, 'cd02-smoke.json'), `${JSON.stringify(receipt, null, 2)}\n`)
console.log(JSON.stringify(receipt))
NODE
