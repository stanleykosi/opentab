#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" == "--help" ]]; then
  cat <<'USAGE'
Usage:
  APP_ENV=production \
  BACKUP_CHANGE_ID=<release-or-incident-id> \
  BACKUP_OUTPUT_DIRECTORY=/secure/path/outside/the/repository \
  BACKUP_CONFIRMATION=CREATE_RESTRICTED_BACKUP \
  DATABASE_BACKUP_URL=<read-capable-postgresql-url> \
  scripts/backup-postgres.sh
USAGE
  exit 0
fi

: "${APP_ENV:?APP_ENV is required}"
: "${BACKUP_CHANGE_ID:?BACKUP_CHANGE_ID is required}"
: "${BACKUP_OUTPUT_DIRECTORY:?BACKUP_OUTPUT_DIRECTORY is required}"
: "${DATABASE_BACKUP_URL:?DATABASE_BACKUP_URL is required}"

if [[ "${BACKUP_CONFIRMATION:-}" != "CREATE_RESTRICTED_BACKUP" ]]; then
  echo "BACKUP_CONFIRMATION must equal CREATE_RESTRICTED_BACKUP." >&2
  exit 2
fi
if [[ ! "$APP_ENV" =~ ^(preview|staging|demo-mainnet|production|local|test)$ ]]; then
  echo "APP_ENV is not an allowed environment." >&2
  exit 2
fi
if [[ ! "$BACKUP_CHANGE_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{2,119}$ ]]; then
  echo "BACKUP_CHANGE_ID must be a 3-120 character opaque reference." >&2
  exit 2
fi
for command in node pg_dump pg_restore sha256sum; do
  command -v "$command" >/dev/null || { echo "$command is required." >&2; exit 3; }
done

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
mkdir -p -- "$BACKUP_OUTPUT_DIRECTORY"
output_root="$(cd "$BACKUP_OUTPUT_DIRECTORY" && pwd -P)"
case "$output_root/" in
  "$repository_root"/*)
    echo "Database backups must be written outside the source repository." >&2
    exit 2
    ;;
esac

umask 077
service_directory="$(mktemp -d)"
service_file="$service_directory/pg_service.conf"
password_file="$service_directory/pgpass"
archive=""
completed=false
cleanup() {
  rm -f -- "$service_file" "$password_file"
  rmdir -- "$service_directory" 2>/dev/null || true
  if [[ "$completed" != "true" && -n "$archive" ]]; then
    rm -f -- "$archive" "$archive.sha256"
  fi
}
trap cleanup EXIT
DATABASE_SERVICE_URL="$DATABASE_BACKUP_URL" \
DATABASE_SERVICE_OUTPUT="$service_file" \
DATABASE_SERVICE_PASSWORD_OUTPUT="$password_file" \
DATABASE_SERVICE_NAME=opentab_backup \
node "$repository_root/scripts/write-libpq-service.mjs"
export PGSERVICEFILE="$service_file"
export PGSERVICE=opentab_backup
unset DATABASE_BACKUP_URL

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
archive="$(mktemp --tmpdir="$output_root" "opentab-${APP_ENV}-${BACKUP_CHANGE_ID}-${timestamp}-XXXXXX.dump")"
archive_name="$(basename "$archive")"

pg_dump --dbname "service=$PGSERVICE" --format=custom --compress=9 --no-owner --no-privileges --file "$archive"
pg_restore --list "$archive" >/dev/null
(
  cd "$output_root"
  sha256sum -- "$archive_name" >"$archive_name.sha256"
)
chmod 600 "$archive" "$archive.sha256"
completed=true

printf 'Backup verified: %s\n' "$archive"
printf 'Checksum: %s\n' "$archive.sha256"
printf 'No database URL or row data was printed. Move both files to approved encrypted storage.\n'
