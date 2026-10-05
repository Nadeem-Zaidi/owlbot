#!/usr/bin/env bash
# Dump the database to deploy/ec2/backups (keeps the last 7), and copy it to
# S3 when BACKUP_S3_URI is set (e.g. s3://my-bucket/owlbot-backups/).
# Daily at 03:00 — add with `crontab -e`:
#   0 3 * * * /home/ubuntu/apps/owlbot/deploy/ec2/backup.sh >> /home/ubuntu/owlbot-backup.log 2>&1
#
# Restore a dump:
#   gunzip -c backups/owlbot-YYYYmmdd-HHMM.sql.gz | docker compose exec -T postgres psql -U "$POSTGRES_USERNAME" -d "$POSTGRES_DATABASE"
set -euo pipefail
cd "$(dirname "$0")"
env_get() { grep -E "^$1=" .env | tail -n1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' || true; }
POSTGRES_USERNAME="$(env_get POSTGRES_USERNAME)"
POSTGRES_DATABASE="$(env_get POSTGRES_DATABASE)"
BACKUP_S3_URI="${BACKUP_S3_URI:-$(env_get BACKUP_S3_URI)}"

mkdir -p backups
file="backups/owlbot-$(date +%Y%m%d-%H%M).sql.gz"
docker compose exec -T postgres pg_dump -U "$POSTGRES_USERNAME" -d "$POSTGRES_DATABASE" --no-owner | gzip > "$file"
echo "saved $file ($(du -h "$file" | cut -f1))"

ls -1t backups/owlbot-*.sql.gz | tail -n +8 | xargs -r rm --

if [ -n "${BACKUP_S3_URI:-}" ]; then
  # Uses the instance's IAM role (needs s3:PutObject on that bucket/prefix).
  docker run --rm -v "$PWD/backups:/b:ro" amazon/aws-cli s3 cp "/b/$(basename "$file")" "$BACKUP_S3_URI"
fi
