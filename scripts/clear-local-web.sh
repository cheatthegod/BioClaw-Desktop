#!/usr/bin/env bash
# Clear all local-web chat history and trace events
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"
DB="$ROOT/store/messages.db"

if [ ! -f "$DB" ]; then
  echo "Database not found: $DB"
  exit 1
fi

echo "Clearing local-web data from $DB ..."

sqlite3 "$DB" <<'SQL'
DELETE FROM agent_trace_events WHERE group_folder = 'local-web';
DELETE FROM agent_trace_events WHERE chat_jid LIKE '%local-web%';
DELETE FROM messages WHERE chat_jid LIKE '%local-web%';
DELETE FROM chats WHERE jid LIKE '%local-web%';
SQL

echo "Done. Remaining trace events: $(sqlite3 "$DB" "SELECT count(*) FROM agent_trace_events")"
echo "Remaining messages: $(sqlite3 "$DB" "SELECT count(*) FROM messages")"
