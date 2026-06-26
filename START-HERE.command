#!/bin/bash
# Growth Intelligence Platform — PRO launcher
# Double-click this file to start the app. (First time: right-click → Open.)
cd "$(dirname "$0")"

clear
echo "  ◆ Growth Intelligence Platform — PRO"
echo "  --------------------------------------"

if ! command -v node >/dev/null 2>&1; then
  echo "  Node.js is not installed."
  echo "  1) Go to https://nodejs.org  2) Download the LTS version  3) Install it"
  echo "  Then double-click this file again."
  echo ""
  read -p "  Press Enter to close..."
  exit 1
fi

PORT=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('config.json')).port||5180)}catch(e){console.log(5180)}")

# open the browser shortly after the server boots
( sleep 2; open "http://localhost:${PORT}" ) &

echo "  Starting… your browser will open at http://localhost:${PORT}"
echo "  Keep this window open while you use the app. Close it to stop."
echo ""
node server.js

read -p "  Server stopped. Press Enter to close..."
