#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" == "--help" ]]; then
  cat <<'USAGE'
Usage (new empty recovery database only):
  APP_ENV=recovery \
  RESTORE_ARCHIVE=/secure/path/opentab-backup.dump \
  RESTORE_CONFIRMATION=RESTORE_TO_NEW_EMPTY_DATABASE \
  DATABASE_RESTORE_URL=<new-empty-postgresql-url> \
  scripts/restore-postgres.sh
USAGE
  exit 0
fi

: "${APP_ENV:?APP_ENV is required}"
: "${RESTORE_ARCHIVE:?RESTORE_ARCHIVE is required}"
: "${DATABASE_RESTORE_URL:?DATABASE_RESTORE_URL is required}"

if [[ "$APP_ENV" != "recovery" ]]; then
  echo "Restore refuses every APP_ENV except recovery; restore into a new isolated database." >&2
  exit 2
fi
if [[ "${RESTORE_CONFIRMATION:-}" != "RESTORE_TO_NEW_EMPTY_DATABASE" ]]; then
  echo "RESTORE_CONFIRMATION must equal RESTORE_TO_NEW_EMPTY_DATABASE." >&2
  exit 2
fi
if [[ ! -f "$RESTORE_ARCHIVE" ]]; then
  echo "RESTORE_ARCHIVE does not exist." >&2
  exit 2
fi
for command in node pg_restore psql sha256sum; do
  command -v "$command" >/dev/null || { echo "$command is required." >&2; exit 3; }
done

archive_directory="$(cd "$(dirname "$RESTORE_ARCHIVE")" && pwd -P)"
archive_name="$(basename "$RESTORE_ARCHIVE")"
checksum_name="$archive_name.sha256"
if [[ -f "$archive_directory/$checksum_name" ]]; then
  (
    cd "$archive_directory"
    sha256sum --check --status -- "$checksum_name"
  ) || {
    echo "Backup checksum verification failed." >&2
    exit 4
  }
else
  echo "The adjacent .sha256 file is required." >&2
  exit 4
fi

RESTORE_ARCHIVE="$archive_directory/$archive_name"
repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
umask 077
service_directory="$(mktemp -d)"
service_file="$service_directory/pg_service.conf"
password_file="$service_directory/pgpass"
cleanup() {
  rm -f -- "$service_file" "$password_file"
  rmdir -- "$service_directory" 2>/dev/null || true
}
trap cleanup EXIT
DATABASE_SERVICE_URL="$DATABASE_RESTORE_URL" \
DATABASE_SERVICE_OUTPUT="$service_file" \
DATABASE_SERVICE_PASSWORD_OUTPUT="$password_file" \
DATABASE_SERVICE_NAME=opentab_restore \
node "$repository_root/scripts/write-libpq-service.mjs"
export PGSERVICEFILE="$service_file"
export PGSERVICE=opentab_restore
unset DATABASE_RESTORE_URL
object_count="$(psql --no-psqlrc --tuples-only --no-align --set ON_ERROR_STOP=1 --command "
  with user_objects as (
    select class.oid
      from pg_catalog.pg_class as class
      join pg_catalog.pg_namespace as namespace on namespace.oid = class.relnamespace
     where namespace.nspname not in ('pg_catalog', 'information_schema', 'pg_toast')
       and namespace.nspname !~ '^pg_(temp|toast_temp)_'
    union all
    select proc.oid
      from pg_catalog.pg_proc as proc
      join pg_catalog.pg_namespace as namespace on namespace.oid = proc.pronamespace
     where namespace.nspname not in ('pg_catalog', 'information_schema', 'pg_toast')
       and namespace.nspname !~ '^pg_(temp|toast_temp)_'
    union all
    select typ.oid
      from pg_catalog.pg_type as typ
      join pg_catalog.pg_namespace as namespace on namespace.oid = typ.typnamespace
     where namespace.nspname not in ('pg_catalog', 'information_schema', 'pg_toast')
       and namespace.nspname !~ '^pg_(temp|toast_temp)_'
       and typ.typtype in ('c', 'd', 'e', 'r', 'm')
    union all
    select event_trigger.oid from pg_catalog.pg_event_trigger as event_trigger
    union all
    select namespace.oid
      from pg_catalog.pg_namespace as namespace
     where namespace.nspname not in ('pg_catalog', 'information_schema', 'pg_toast', 'public')
       and namespace.nspname !~ '^pg_(temp|toast_temp)_'
  )
  select count(*) from user_objects;")"
if [[ "$object_count" != "0" ]]; then
  echo "Restore target is not empty; refusing to overwrite it." >&2
  exit 5
fi

pg_restore --file - --no-owner --no-privileges "$RESTORE_ARCHIVE" \
  | psql --quiet --no-psqlrc --output /dev/null --single-transaction --set ON_ERROR_STOP=1
psql --no-psqlrc --set ON_ERROR_STOP=1 --command "select 1" >/dev/null
printf 'Restore completed into the isolated recovery database. Run reconciliation checks before cutover.\n'
