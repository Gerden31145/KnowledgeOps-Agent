#!/bin/sh
set -eu

# Certbot runs deploy hooks only after successful renewal.
# Other certificates on this VPS are outside this hook's scope.
case "${RENEWED_LINEAGE:-}" in
  /etc/letsencrypt/live/knowops.site|/etc/letsencrypt/live/game.gerden-shop.cn) ;;
  *) exit 0 ;;
esac

/usr/sbin/nginx -t
/usr/bin/systemctl reload nginx
