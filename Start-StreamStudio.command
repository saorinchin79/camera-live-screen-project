#!/bin/bash
# Stream Studio: starts the server and opens the admin page in the browser (macOS and Linux).
# Keep this window open while you use Stream Studio; close it to stop Stream Studio.
#   Start-StreamStudio.command --no-browser   starts it without the browser
# The port is 3000; to use another one, write the number (for example 3001) into data/port.txt.
cd "$(dirname "$0")" || exit 1
[ "$1" = "--no-browser" ] || export OPEN_BROWSER=1
NODE=node
[ -x runtime/node/bin/node ] && NODE=runtime/node/bin/node
if ! command -v "$NODE" >/dev/null; then
  echo "Node.js was not found. Run setup/install.sh first."
  read -r -p "Press Enter to close this window... " _
  exit 1
fi
# the full path tells the installer which running server belongs to this folder
"$NODE" "$(pwd -P)/server.js" || { echo; read -r -p "Press Enter to close this window... " _; }
