#!/bin/bash
# Double-click this file on macOS to start the app.
cd "$(dirname "$0")"

echo ""
echo "  FuelBand Revival"
echo "  ================"
echo ""

if ! command -v node >/dev/null 2>&1; then
  echo "  Node.js is not installed."
  echo ""
  echo "  Please install it from https://nodejs.org (choose the LTS version),"
  echo "  then double-click this file again."
  echo ""
  read -n 1 -s -r -p "  Press any key to close."
  exit 1
fi

if [ ! -d ../node_modules ]; then
  echo "  First run — installing what's needed (about a minute)..."
  echo ""
  ( cd .. && npm install ) || {
    echo ""
    echo "  Install failed. Check your internet connection and try again."
    read -n 1 -s -r -p "  Press any key to close."
    exit 1
  }
  echo ""
fi

echo "  Starting… your browser will open automatically."
echo "  Keep THIS window open while you use the app."
echo ""
node server.js
