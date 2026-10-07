#!/bin/sh
# Runs the server. With LITESTREAM_REPLICA_URL set (e.g. s3://bucket/browserlace), the
# database is restored from the replica on an empty volume and replicated continuously.
set -e
if [ -n "$LITESTREAM_REPLICA_URL" ]; then
  litestream restore -if-db-not-exists -if-replica-exists "$DATABASE_PATH"
  exec litestream replicate -exec "node index.mjs"
fi
exec node index.mjs
