#!/usr/bin/env bash
#
# Restore CockroachDB from a backup created by db-backup.sh
#
# Usage:
#   ./scripts/db-restore.sh backups/focale_backup_2026-03-15_05-59-21.tar.gz
#   ./scripts/db-restore.sh --list                    # List available backups
#   ./scripts/db-restore.sh --latest                  # Restore the most recent backup
#   DATABASE_URL=xxx ./scripts/db-restore.sh backup.tar.gz  # Explicit connection string
#
# The script will:
#   1. Show you what's in the backup
#   2. Ask for confirmation before wiping anything
#   3. Drop all existing tables
#   4. Recreate schema from schema.sql
#   5. Import CSV data with COPY FROM STDIN

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
BACKUP_DIR="${BACKUP_DIR:-$PROJECT_DIR/backups}"

# Load DATABASE_URL from .env.prod if not already set
if [ -z "${DATABASE_URL:-}" ]; then
  ENV_FILE="$PROJECT_DIR/.env.prod"
  if [ -f "$ENV_FILE" ]; then
    DATABASE_URL=$(grep -E '^DATABASE_URL=' "$ENV_FILE" | cut -d '=' -f2- | tr -d '"' | tr -d "'")
  else
    echo "ERROR: .env.prod not found at $ENV_FILE"
    exit 1
  fi
fi

if [ -z "${DATABASE_URL:-}" ]; then
  echo "ERROR: DATABASE_URL not set."
  exit 1
fi

# ── Handle --list ──────────────────────────────────────────────────
if [ "${1:-}" = "--list" ]; then
  echo "Available backups:"
  echo ""
  if ls "$BACKUP_DIR"/focale_backup_*.tar.gz 1>/dev/null 2>&1; then
    for f in "$BACKUP_DIR"/focale_backup_*.tar.gz; do
      SIZE=$(du -h "$f" | cut -f1)
      NAME=$(basename "$f")
      echo "  $NAME  ($SIZE)"
    done
  else
    echo "  No backups found in $BACKUP_DIR"
  fi
  exit 0
fi

# ── Resolve backup file ───────────────────────────────────────────
if [ "${1:-}" = "--latest" ]; then
  BACKUP_FILE=$(ls -t "$BACKUP_DIR"/focale_backup_*.tar.gz 2>/dev/null | head -1)
  if [ -z "$BACKUP_FILE" ]; then
    echo "ERROR: No backups found in $BACKUP_DIR"
    exit 1
  fi
  echo "Using latest backup: $(basename "$BACKUP_FILE")"
elif [ -n "${1:-}" ]; then
  BACKUP_FILE="$1"
else
  echo "Usage: $0 <backup-file.tar.gz | --latest | --list>"
  exit 1
fi

if [ ! -f "$BACKUP_FILE" ]; then
  echo "ERROR: Backup file not found: $BACKUP_FILE"
  exit 1
fi

# ── Extract backup ────────────────────────────────────────────────
WORK_DIR=$(mktemp -d)
trap 'rm -rf "$WORK_DIR"' EXIT

tar -xzf "$BACKUP_FILE" -C "$WORK_DIR"
EXTRACTED_DIR=$(ls "$WORK_DIR")
DATA_DIR="$WORK_DIR/$EXTRACTED_DIR"

# ── Preview backup contents ──────────────────────────────────────
echo ""
echo "=== Backup Contents ==="
echo "Backup: $(basename "$BACKUP_FILE")"
echo ""

CSV_FILES=$(find "$DATA_DIR" -name "*.csv" -type f | sort)
for CSV in $CSV_FILES; do
  TABLE=$(basename "$CSV" .csv)
  ROWS=$(tail -n +2 "$CSV" | wc -l | tr -d ' ')
  printf "  %-30s %s rows\n" "$TABLE" "$ROWS"
done

echo ""
echo "WARNING: This will DROP ALL TABLES and restore from backup."
echo "         All current data in the database will be lost."
echo ""
read -r -p "Type 'yes' to continue: " CONFIRM

if [ "$CONFIRM" != "yes" ]; then
  echo "Aborted."
  exit 0
fi

echo ""
echo "[$(date)] Starting restore..."

# ── Step 1: Drop all existing tables ─────────────────────────────
echo "[$(date)] Dropping existing tables..."

DROP_SQL=$(psql "$DATABASE_URL" -t -A -c "
  SELECT 'DROP TABLE IF EXISTS \"' || table_name || '\" CASCADE;'
  FROM information_schema.tables
  WHERE table_schema = 'public'
    AND table_type = 'BASE TABLE';
" 2>/dev/null)

if [ -n "$DROP_SQL" ]; then
  echo "$DROP_SQL" | psql "$DATABASE_URL" -q 2>/dev/null
fi

echo "[$(date)] Tables dropped."

# ── Step 2: Recreate schema ──────────────────────────────────────
echo "[$(date)] Recreating schema..."
psql "$DATABASE_URL" -q < "$DATA_DIR/schema.sql" 2>/dev/null
echo "[$(date)] Schema created."

# ── Step 3: Import data (respecting foreign key order) ───────────
# Order tables so parents are loaded before children
ORDERED_TABLES=(
  "_AccessPrerequisites"
  "clients"
  "users"
  "events"
  "forms"
  "event_pricing"
  "event_access"
  "sponsorship_batches"
  "sponsorships"
  "registrations"
  "sponsorship_usages"
  "email_templates"
  "email_logs"
  "audit_logs"
)

echo "[$(date)] Importing data..."

IMPORTED=0
for TABLE in "${ORDERED_TABLES[@]}"; do
  CSV="$DATA_DIR/$TABLE.csv"
  if [ -f "$CSV" ]; then
    ROWS=$(tail -n +2 "$CSV" | wc -l | tr -d ' ')
    if [ "$ROWS" -gt 0 ]; then
      echo "[$(date)] Importing $TABLE ($ROWS rows)..."
      # Use COPY FROM STDIN with CSV HEADER to import
      psql "$DATABASE_URL" -c "COPY \"$TABLE\" FROM STDIN WITH CSV HEADER;" < "$CSV" 2>/dev/null
      IMPORTED=$((IMPORTED + 1))
    else
      echo "[$(date)] Skipping $TABLE (empty)"
    fi
  fi
done

# Import any tables not in the ordered list (safety net)
for CSV in $CSV_FILES; do
  TABLE=$(basename "$CSV" .csv)
  ALREADY_DONE=false
  for DONE in "${ORDERED_TABLES[@]}"; do
    if [ "$TABLE" = "$DONE" ]; then
      ALREADY_DONE=true
      break
    fi
  done
  if [ "$ALREADY_DONE" = false ]; then
    ROWS=$(tail -n +2 "$CSV" | wc -l | tr -d ' ')
    if [ "$ROWS" -gt 0 ]; then
      echo "[$(date)] Importing $TABLE ($ROWS rows) [unordered]..."
      psql "$DATABASE_URL" -c "COPY \"$TABLE\" FROM STDIN WITH CSV HEADER;" < "$CSV" 2>/dev/null
      IMPORTED=$((IMPORTED + 1))
    fi
  fi
done

echo "[$(date)] Restore complete. $IMPORTED tables imported."
echo ""
echo "Next steps:"
echo "  1. Run 'bun run db:verify' to check data integrity"
echo "  2. Run 'bun run db:generate' to regenerate Prisma client if schema changed"
