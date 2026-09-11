#!/bin/sh
set -eu

# Named volumes are created by Docker as root. Prepare the writable Banking
# volume before dropping privileges for the actual Node process.
mkdir -p /var/lib/yuvomi-banking
chown -R node:node /var/lib/yuvomi-banking

exec gosu node "$@"
