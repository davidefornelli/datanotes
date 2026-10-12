#!/bin/sh
# Settings: /config/settings.json (created with a random token on first start, port 27150).
# Named tokens (programs, agents) are created with POST /datanotes/tokens/create/.
# Bind mounts from Windows/macOS hosts deliver no file events: DATANOTES_WATCH defaults to poll.
set -e
# The settings file holds the owner token: everything the engine creates is private to its user.
umask 077
SETTINGS=/config/settings.json
if [ ! -f "$SETTINGS" ]; then
  TOKEN=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
  printf '{\n  "httpServerPort": %s,\n  "httpServerToken": "%s"\n}\n' "${DATANOTES_PORT:-27150}" "$TOKEN" > "$SETTINGS"
  echo "datanotes: created $SETTINGS (token in that file)"
fi
set -- --vault /vault --settings "$SETTINGS" --host 0.0.0.0 --watch "${DATANOTES_WATCH:-poll}" --poll-ms "${DATANOTES_POLL_MS:-3000}" "$@"
exec node /app/datanotes-service.cjs "$@"
