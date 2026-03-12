#!/usr/bin/env bash
# Send a message to Telegram from shell scripts
# Usage: ./notify.sh "Your message here"

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/../.env" 2>/dev/null || true

if [ -z "${TELEGRAM_BOT_TOKEN:-}" ] || [ -z "${ALLOWED_CHAT_ID:-}" ]; then
  echo "Error: TELEGRAM_BOT_TOKEN and ALLOWED_CHAT_ID must be set in .env"
  exit 1
fi

MESSAGE="${1:?Usage: notify.sh \"message\"}"

curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
  -H "Content-Type: application/json" \
  -d "{\"chat_id\": \"${ALLOWED_CHAT_ID}\", \"text\": \"${MESSAGE}\"}" > /dev/null

echo "Sent to Telegram"
