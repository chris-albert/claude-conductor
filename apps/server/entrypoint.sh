#!/bin/sh
# Fix ownership of mounted volumes (they may have been created as root)
chown -R conductor:conductor /home/conductor/.claude 2>/dev/null || true

# Drop privileges and exec the CMD
exec su conductor -s /bin/sh -c "exec $*"
