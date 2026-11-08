#!/bin/sh
# Double-click this file on a Mac to start the hub and open the dashboard.
# Close the Terminal window (or press Ctrl+C) to stop it.
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Download it from https://nodejs.org, then double-click this file again."
  printf 'Press Return to close. '; read -r _
  exit 1
fi
PORT="${WEB_PORT:-8080}"
( sleep 1.5; open "http://localhost:$PORT" ) &
node server.js
