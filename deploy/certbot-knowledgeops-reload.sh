#!/bin/sh
set -eu

# Certbot runs deploy hooks only after successful renewal.
# Other certificates on this VPS are outside this hook's scope.
if [ "${RENEWED_LINEAGE:-}" != '/etc/letsencrypt/live/game.gerden-shop.cn' ]; then
  exit 0
fi

/usr/sbin/nginx -t
/usr/bin/systemctl reload nginx
