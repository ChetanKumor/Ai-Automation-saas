#!/usr/bin/env bash
# Usage: scripts/db/backup.sh <connection-string> [output-dir]
#
# Dumps the named database in pg_dump custom format (-Fc).
# Output: <output-dir>/<dbname>_<UTC-ISO-ts>.dump  (default output-dir: backups/)
#
# Exits nonzero on any failure; prints SHA-256 of the artifact on success.
# Never reads DATABASE_URL implicitly — connection string must be explicit.
set -euo pipefail

if [[ $# -lt 1 ]]; then
  printf 'Usage: %s <connection-string> [output-dir]\n' "$0" >&2
  exit 1
fi

CONN="$1"
OUTDIR="${2:-backups}"
OUTDIR="${OUTDIR%/}"  # strip trailing slash

# Locate pg_dump: PATH first, then Windows PostgreSQL 18 default install
if command -v pg_dump >/dev/null 2>&1; then
  PG_DUMP=pg_dump
elif [[ -x "/c/Program Files/PostgreSQL/18/bin/pg_dump.exe" ]]; then
  PG_DUMP="/c/Program Files/PostgreSQL/18/bin/pg_dump.exe"
else
  printf 'ERROR: pg_dump not found in PATH or /c/Program Files/PostgreSQL/18/bin/\n' >&2
  printf 'Install the PostgreSQL client tools matching the server major version.\n' >&2
  exit 1
fi

# Parse database name from the connection string URL
DB_NAME=$(node --input-type=module <<EOF 2>/dev/null
const u = new URL('${CONN}');
process.stdout.write(u.pathname.replace(/^\\//, ''));
EOF
) || {
  printf 'ERROR: Cannot parse database name from connection string\n' >&2
  exit 1
}

if [[ -z "$DB_NAME" ]]; then
  printf 'ERROR: Connection string has no database path component\n' >&2
  exit 1
fi

TS=$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "$OUTDIR"
OUTFILE="$OUTDIR/${DB_NAME}_${TS}.dump"

printf 'Backing up database: %s\n' "$DB_NAME"
printf 'Output: %s\n' "$OUTFILE"

if ! "$PG_DUMP" \
    --format=custom \
    --no-password \
    --file="$OUTFILE" \
    "$CONN"; then
  printf '\nERROR: pg_dump failed — removing partial artifact\n' >&2
  rm -f "$OUTFILE"
  exit 1
fi

if command -v sha256sum >/dev/null 2>&1; then
  CHECKSUM=$(sha256sum "$OUTFILE" | awk '{print $1}')
elif command -v shasum >/dev/null 2>&1; then
  CHECKSUM=$(shasum -a 256 "$OUTFILE" | awk '{print $1}')
else
  CHECKSUM="(sha256 utility not available on this system)"
fi

printf 'SHA256: %s\n' "$CHECKSUM"
printf 'Done:   %s\n' "$OUTFILE"
