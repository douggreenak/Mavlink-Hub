#!/bin/sh
# Double-click this file on a Mac to start the hub and open the dashboard.
# Close the Terminal window (or press Ctrl+C) to stop it.
cd "$(dirname "$0")" || exit 1
# The downloadable package carries its own Node (one build for Apple Silicon, one for Intel); otherwise use the system one.
case "$(uname -m)" in arm64) BUNDLED="./runtime/node-arm64" ;; *) BUNDLED="./runtime/node-x64" ;; esac
if [ -f "$BUNDLED" ]; then chmod +x "$BUNDLED" 2>/dev/null; xattr -dr com.apple.quarantine . 2>/dev/null; NODE="$BUNDLED"; else NODE="$(command -v node)"; fi
if [ -z "$NODE" ]; then
  echo "Node.js is not installed. Download it from https://nodejs.org, then double-click this file again."
  printf 'Press Return to close. '; read -r _
  exit 1
fi
PORT="${WEB_PORT:-8080}"
( sleep 1.5; open "http://localhost:$PORT" ) &
"$NODE" server.js
