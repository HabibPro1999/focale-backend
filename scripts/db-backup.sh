#!/usr/bin/env bash
#
# Daily CockroachDB backup script
# Uses COPY TO STDOUT (CockroachDB-compatible, unlike pg_dump)
#
# Usage:
#   ./scripts/db-backup.sh                    # Uses DATABASE_URL from .env.prod
#   DATABASE_URL=xxx ./scripts/db-backup.sh   # Explicit connection string
#
# Cron (daily at 3 AM):
#   0 3 * * * cd /path/to/backend && ./scripts/db-backup.sh >> backups/backup.log 2>&1

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
BACKUP_DIR="${BACKUP_DIR:-$PROJECT_DIR/backups}"
RETENTION_DAYS="${RETENTION_DAYS:-7}"
TIMESTAMP=$(date +"%Y-%m-%d_%H-%M-%S")
WORK_DIR="$BACKUP_DIR/focale_backup_$TIMESTAMP"
BACKUP_FILE="$WORK_DIR.tar.gz"

# Load DATABASE_URL from .env.prod if not already set
if [ -z "${DATABASE_URL:-}" ]; then
  ENV_FILE="$PROJECT_DIR/.env.prod"
  if [ -f "$ENV_FILE" ]; then
    DATABASE_URL=$(grep -E '^DATABASE_URL=' "$ENV_FILE" | cut -d '=' -f2- | tr -d '"' | tr -d "'")
  else
    echo "[$(date)] ERROR: .env.prod not found at $ENV_FILE"
    exit 1
  fi
fi

if [ -z "${DATABASE_URL:-}" ]; then
  echo "[$(date)] ERROR: DATABASE_URL not set."
  exit 1
fi

# Skip if today's backup already exists (avoids duplicates from launchd + login)
TODAY=$(date +"%Y-%m-%d")
if ls "$BACKUP_DIR"/focale_backup_"${TODAY}"_*.tar.gz 1>/dev/null 2>&1; then
  echo "[$(date)] Backup for $TODAY already exists. Skipping."
  exit 0
fi

# Create working directory
mkdir -p "$WORK_DIR"

echo "[$(date)] Starting backup..."

# 1. Export schema (CREATE TABLE statements)
echo "[$(date)] Exporting schema..."
psql "$DATABASE_URL" -c "SHOW CREATE ALL TABLES;" -t -A > "$WORK_DIR/schema.sql" 2>/dev/null
echo "[$(date)] Schema exported."

# 2. Get list of user tables
TABLES=$(psql "$DATABASE_URL" -t -A -c "
  SELECT table_name FROM information_schema.tables
  WHERE table_schema = 'public'
    AND table_type = 'BASE TABLE'
    AND table_name NOT LIKE '_prisma%'
  ORDER BY table_name;
" 2>/dev/null)

# 3. Export each table as CSV
TABLE_COUNT=0
for TABLE in $TABLES; do
  echo "[$(date)] Exporting table: $TABLE"
  psql "$DATABASE_URL" -c "COPY \"$TABLE\" TO STDOUT WITH CSV HEADER;" > "$WORK_DIR/$TABLE.csv" 2>/dev/null
  ROWS=$(tail -n +2 "$WORK_DIR/$TABLE.csv" | wc -l | tr -d ' ')
  echo "[$(date)]   → $ROWS rows"
  TABLE_COUNT=$((TABLE_COUNT + 1))
done

echo "[$(date)] Exported $TABLE_COUNT tables."

# 4. Compress into a single archive
tar -czf "$BACKUP_FILE" -C "$BACKUP_DIR" "$(basename "$WORK_DIR")"
rm -rf "$WORK_DIR"

BACKUP_SIZE=$(du -h "$BACKUP_FILE" | cut -f1)
echo "[$(date)] Backup complete: $BACKUP_FILE ($BACKUP_SIZE)"

# 5. Rotate old backups
DELETED=0
if [ "$RETENTION_DAYS" -gt 0 ]; then
  while IFS= read -r old_file; do
    rm -f "$old_file"
    DELETED=$((DELETED + 1))
  done < <(find "$BACKUP_DIR" -name "focale_backup_*.tar.gz" -mtime +"$RETENTION_DAYS" -type f 2>/dev/null)
fi

if [ "$DELETED" -gt 0 ]; then
  echo "[$(date)] Rotated $DELETED backup(s) older than $RETENTION_DAYS days."
fi

TOTAL=$(find "$BACKUP_DIR" -name "focale_backup_*.tar.gz" -type f | wc -l | tr -d ' ')
echo "[$(date)] Total backups on disk: $TOTAL"
