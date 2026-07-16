#!/usr/bin/env bash
# Usage: scripts/db/restore.sh <dump-file> <target-connection-string>
#
# Restores a pg_dump custom-format dump to the target database.
#
# Safety guard: REFUSES if the target database already contains any tables in
# the public schema. Always restore into a freshly created, empty database.
#
# Uses --no-owner --no-privileges so the restoring role becomes the owner,
# and wraps the restore in a single transaction where possible.
set -euo pipefail

if [[ $# -ne 2 ]]; then
  printf 'Usage: %s <dump-file> <target-connection-string>\n' "$0" >&2
  exit 1
fi

DUMP="$1"
TARGET="$2"

if [[ ! -f "$DUMP" ]]; then
  printf 'ERROR: Dump file not found: %s\n' "$DUMP" >&2
  exit 1
fi

# Locate pg_restore and psql: PATH first, then Windows PostgreSQL 18 default install
if command -v pg_restore >/dev/null 2>&1; then
  PG_RESTORE=pg_restore
  PSQL=psql
elif [[ -x "/c/Program Files/PostgreSQL/18/bin/pg_restore.exe" ]]; then
  PG_RESTORE="/c/Program Files/PostgreSQL/18/bin/pg_restore.exe"
  PSQL="/c/Program Files/PostgreSQL/18/bin/psql.exe"
else
  printf 'ERROR: pg_restore not found in PATH or /c/Program Files/PostgreSQL/18/bin/\n' >&2
  printf 'Install the PostgreSQL client tools matching the server major version.\n' >&2
  exit 1
fi

# Safety guard: refuse if target database is non-empty
TABLE_COUNT=$("$PSQL" --no-psqlrc --tuples-only \
  --command "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE';" \
  "$TARGET" 2>/dev/null | tr -d ' \n\r') || {
  printf 'ERROR: Cannot connect to target database — check the connection string and network access\n' >&2
  exit 1
}

if [[ -z "$TABLE_COUNT" ]]; then
  printf 'ERROR: Could not determine table count in target database\n' >&2
  exit 1
fi

if [[ "$TABLE_COUNT" -gt 0 ]]; then
  printf 'ERROR: Target database is non-empty (%s public tables found).\n' "$TABLE_COUNT" >&2
  printf 'Refusing to restore into a live database. Create a fresh empty database and retry:\n' >&2
  printf '  createdb -e <newdbname>  (or CREATE DATABASE in psql)\n' >&2
  exit 1
fi

printf 'Restoring %s into target database (%s public tables — safe to proceed).\n' "$DUMP" "$TABLE_COUNT"

if ! "$PG_RESTORE" \
    --no-owner \
    --no-privileges \
    --single-transaction \
    --no-password \
    --dbname="$TARGET" \
    "$DUMP"; then
  printf '\nERROR: pg_restore failed — target database may be in a partial state\n' >&2
  printf 'Recommended: drop and recreate the target database, then retry.\n' >&2
  exit 1
fi

printf 'Restore complete.\n'
