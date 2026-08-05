#!/usr/bin/env bash

set -euo pipefail

export DEBIAN_FRONTEND=noninteractive

action="${1:-}"
environment_file="${2:-}"

if [[ ! "$action" =~ ^(up|status|stop)$ ]]; then
  printf '%s\n' 'Expected action: up, status, or stop.' >&2
  exit 1
fi

if [[ ! -f "$environment_file" ]]; then
  printf 'Environment file not found: %s\n' "$environment_file" >&2
  exit 1
fi

read_environment_value() {
  local key="$1"
  local value

  value="$(sed -n "s/^${key}=//p" "$environment_file" | tail -n 1 | tr -d '\r')"
  if [[ -z "$value" ]]; then
    printf 'Missing %s in %s\n' "$key" "$environment_file" >&2
    exit 1
  fi

  printf '%s' "$value"
}

check_protocols() {
  PGPASSWORD="$postgres_password" psql \
    --host 127.0.0.1 \
    --port "$postgres_port" \
    --username "$postgres_user" \
    --dbname "$postgres_database" \
    --tuples-only \
    --no-align \
    --command 'SELECT 1' | grep --quiet '^1$'

  redis-cli -h 127.0.0.1 -p "$redis_port" ping | grep --quiet '^PONG$'
}

redis_server_version() {
  redis-server --version 2>/dev/null | sed -n 's/.* v=\([^ ]*\).*/\1/p'
}

install_redis_7_4() {
  apt-get update
  apt-get install --yes ca-certificates curl gpg lsb-release

  curl --fail --silent --show-error --location https://packages.redis.io/gpg |
    gpg --dearmor --yes --output /usr/share/keyrings/redis-archive-keyring.gpg
  chmod 644 /usr/share/keyrings/redis-archive-keyring.gpg

  printf 'deb [signed-by=/usr/share/keyrings/redis-archive-keyring.gpg] https://packages.redis.io/deb %s main\n' \
    "$(lsb_release -cs)" >/etc/apt/sources.list.d/redis.list
  printf '%s\n' \
    'Package: redis redis-server redis-sentinel redis-tools' \
    'Pin: version 6:7.4.*' \
    'Pin-Priority: 1001' >/etc/apt/preferences.d/redis

  apt-get update
  apt-get install --yes redis redis-server redis-tools
}

postgres_user="$(read_environment_value POSTGRES_USER)"
postgres_password="$(read_environment_value POSTGRES_PASSWORD)"
postgres_database="$(read_environment_value POSTGRES_DB)"
postgres_shadow_database="$(read_environment_value POSTGRES_SHADOW_DB)"
postgres_port="$(read_environment_value POSTGRES_PORT)"
redis_port="$(read_environment_value REDIS_PORT)"

if [[ ! "$postgres_user" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] ||
  [[ ! "$postgres_database" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] ||
  [[ ! "$postgres_shadow_database" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
  printf '%s\n' 'POSTGRES_USER, POSTGRES_DB, and POSTGRES_SHADOW_DB must be simple PostgreSQL identifiers.' >&2
  exit 1
fi

if [[ "$postgres_database" == "$postgres_shadow_database" ]]; then
  printf '%s\n' 'POSTGRES_SHADOW_DB must differ from POSTGRES_DB.' >&2
  exit 1
fi

if [[ "$postgres_port" != '5432' || "$redis_port" != '6379' ]]; then
  printf '%s\n' 'WSL native mode currently requires PostgreSQL 5432 and Redis 6379.' >&2
  exit 1
fi

case "$action" in
  up)
    if ! command -v psql >/dev/null 2>&1; then
      apt-get update
      apt-get install --yes postgresql
    fi

    current_redis_version="$(redis_server_version || true)"
    if [[ -z "$current_redis_version" ]] ||
      ! dpkg --compare-versions "$current_redis_version" ge '7.4.0'; then
      install_redis_7_4
    fi

    service postgresql start
    service redis-server start

    escaped_password="${postgres_password//\'/\'\'}"
    if ! runuser -u postgres -- psql --tuples-only --no-align --command \
      "SELECT 1 FROM pg_roles WHERE rolname = '$postgres_user'" | grep --quiet '^1$'; then
      runuser -u postgres -- psql --set ON_ERROR_STOP=1 --command \
        "CREATE ROLE \"$postgres_user\" LOGIN PASSWORD '$escaped_password'"
    else
      runuser -u postgres -- psql --set ON_ERROR_STOP=1 --command \
        "ALTER ROLE \"$postgres_user\" WITH LOGIN PASSWORD '$escaped_password'"
    fi

    if ! runuser -u postgres -- psql --tuples-only --no-align --command \
      "SELECT 1 FROM pg_database WHERE datname = '$postgres_database'" | grep --quiet '^1$'; then
      runuser -u postgres -- createdb --owner "$postgres_user" "$postgres_database"
    fi

    if ! runuser -u postgres -- psql --tuples-only --no-align --command \
      "SELECT 1 FROM pg_database WHERE datname = '$postgres_shadow_database'" | grep --quiet '^1$'; then
      runuser -u postgres -- createdb --owner "$postgres_user" "$postgres_shadow_database"
    fi

    check_protocols
    printf '%s\n' 'WSL native PostgreSQL and Redis are ready.'
    ;;
  status)
    services_down=0

    if service postgresql status >/dev/null 2>&1; then
      printf '%s\n' 'PostgreSQL: running'
    else
      printf '%s\n' 'PostgreSQL: down'
      services_down=1
    fi

    if service redis-server status >/dev/null 2>&1; then
      printf '%s\n' 'Redis: running'
    else
      printf '%s\n' 'Redis: down'
      services_down=1
    fi

    if [[ "$services_down" -eq 1 ]]; then
      printf '%s\n' 'Run "pnpm infra:up" to start the stopped services.'
    else
      printf '%s\n' 'Run "pnpm infra:check" for protocol-level health checks.'
    fi
    ;;
  stop)
    service postgresql stop
    service redis-server stop
    printf '%s\n' 'WSL native PostgreSQL and Redis are stopped. Data was preserved.'
    ;;
esac
