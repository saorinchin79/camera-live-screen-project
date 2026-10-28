#!/usr/bin/env bash
# GP Studio installer for macOS and Linux.
#
#   curl -fsSL https://raw.githubusercontent.com/saorinchin79/camera-live-screen-project/main/setup/install.sh | bash
#   bash setup/install.sh            (inside a downloaded copy of the project)
#
# It installs into ~/StreamStudio and needs no administrator rights:
#   1. copies GP Studio there (from the folder around this script, or downloaded from GitHub)
#   2. uses Node.js 18+ if this computer has it, otherwise downloads Node.js LTS into StreamStudio/runtime/node
#   3. installs the npm packages, including ffmpeg for the CCTV cameras
#   4. puts a "GP Studio" launcher on the desktop, and on request starts it when you log in
# Running it again (or bash ~/StreamStudio/setup/install.sh) updates GP Studio to the latest version
# and keeps the layout, the cameras and the uploads.
#
# Options: STREAM_STUDIO_DIR=<folder>  STREAM_STUDIO_AUTOSTART=yes|no  STREAM_STUDIO_START=no
#          STREAM_STUDIO_ARCHIVE=<url of a .tar.gz> installs from another copy of the project instead of GitHub

# The whole script is one { } block: bash reads it completely before running it, so an update may
# replace this file while it runs.
{
set -euo pipefail

REPO=saorinchin79/camera-live-screen-project
BRANCH=main
MIN_NODE=18
INSTALL_DIR="${STREAM_STUDIO_DIR:-$HOME/StreamStudio}"

step() { printf '\n\033[36m==> %s\033[0m\n' "$*"; }
info() { printf '    %s\n' "$*"; }
warn() { printf '    \033[33m%s\033[0m\n' "$*"; }
die() {
  printf '\n  \033[31mInstallation failed: %s\033[0m\n' "$*" >&2
  printf '  Fix the problem above and run the installer again; it continues where it stopped.\n' >&2
  exit 1
}

# questions read the keyboard even when this script arrives through a pipe (curl | bash)
ask() {
  local answer=""
  printf '    %s ' "$1" >&2
  read -r answer < /dev/tty 2>/dev/null || printf '\n' >&2
  printf '%s' "${answer:-$2}"
}

fetch() { # fetch URL FILE
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --retry 2 -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$2" "$1"
  else
    die "curl or wget is needed to download files"
  fi
}

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

node_major() { "$1" --version 2>/dev/null | sed -n 's/^v\([0-9][0-9]*\)\..*/\1/p'; }
node_ok() {
  local v
  v="$(node_major "$1")"
  [ "${v:-0}" -ge "$MIN_NODE" ]
}

# data/port.txt changes the port; updates keep the data folder
port_of() {
  local port
  port="$(tr -dc '0-9' < "$1/data/port.txt" 2>/dev/null || true)"
  printf '%s' "${port:-3000}"
}

proc_cwd() {
  if [ -e "/proc/$1/cwd" ]; then readlink "/proc/$1/cwd"; else lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p'; fi
}

# an update replaces node_modules under a running server: stop the server of THIS install only (never
# another GP Studio on the same port, such as a developer copy); "Start now" brings it back
stop_running() {
  local pid args found=""
  for pid in $(pgrep -f 'server\.js' 2>/dev/null || true); do
    args="$(ps -o args= -p "$pid" 2>/dev/null || true)"
    case "$args" in
      *"$INSTALL_DIR/server.js"*) ;;
      *" server.js") [ "$(proc_cwd "$pid")" = "$INSTALL_DIR" ] || continue ;;
      *) continue ;;
    esac
    found="$found $pid"
  done
  [ -n "$found" ] || return 0
  step "Closing the running GP Studio for the update"
  # shellcheck disable=SC2086 # a list of pids
  kill $found 2>/dev/null || true
  sleep 1
}

case "$(uname -s)" in
  Darwin) OS=darwin ;;
  Linux) OS=linux ;;
  *) die "this installer is for macOS and Linux; on Windows double-click Install-Windows.bat" ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) ARCH=x64 ;;
  arm64 | aarch64) ARCH=arm64 ;;
  *) die "this processor ($(uname -m)) is not supported" ;;
esac

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

printf '\n  \033[36mGP Studio setup\033[0m\n  Installs into %s\n' "$INSTALL_DIR"

# ---------- the project ----------

SOURCE=""
SCRIPT="${BASH_SOURCE[0]:-}"
if [ -n "$SCRIPT" ] && [ -f "$SCRIPT" ]; then
  HERE="$(cd "$(dirname "$SCRIPT")/.." && pwd -P)"
  INSTALLED="$( (cd "$INSTALL_DIR" 2>/dev/null && pwd -P) || true)"
  # a downloaded copy installs itself; the installed copy (like a piped script) gets the latest from GitHub
  if [ -f "$HERE/server.js" ] && [ "$HERE" != "$INSTALLED" ]; then SOURCE="$HERE"; fi
fi
if [ -z "$SOURCE" ]; then
  URL="${STREAM_STUDIO_ARCHIVE:-https://github.com/$REPO/archive/refs/heads/$BRANCH.tar.gz}"
  step "Downloading GP Studio"
  info "$URL"
  fetch "$URL" "$TMP/stream-studio.tar.gz"
  mkdir -p "$TMP/src"
  tar -xzf "$TMP/stream-studio.tar.gz" -C "$TMP/src"
  FOUND="$(find "$TMP/src" -maxdepth 2 -name server.js -type f -print -quit)"
  [ -n "$FOUND" ] || die "the download does not contain GP Studio: $URL"
  SOURCE="$(dirname "$FOUND")"
fi

mkdir -p "$INSTALL_DIR"
INSTALL_DIR="$(cd "$INSTALL_DIR" && pwd -P)"
stop_running
if [ "$(cd "$SOURCE" && pwd -P)" != "$INSTALL_DIR" ]; then
  step "Copying GP Studio to $INSTALL_DIR"
  # the code only: an earlier install keeps its data, uploads, runtime and node_modules
  (cd "$SOURCE" && tar -cf - --exclude=./node_modules --exclude=./data --exclude=./uploads --exclude=./runtime --exclude=./.git .) |
    (cd "$INSTALL_DIR" && tar -xf -)
fi
# files from a downloaded archive carry the quarantine mark that makes macOS block double-clicked scripts
if [ "$OS" = darwin ]; then xattr -dr com.apple.quarantine "$INSTALL_DIR" 2>/dev/null || true; fi

# ---------- Node.js ----------

install_node() {
  local key version name expected
  if [ "$OS" = darwin ]; then key="osx-$ARCH-tar"; else key="linux-$ARCH"; fi
  fetch https://nodejs.org/dist/index.tab "$TMP/index.tab"
  # columns: version date files npm v8 uv zlib openssl modules lts security; newest first, lts "-" = not LTS
  version="$(awk -F'\t' -v key="$key" 'NR > 1 && $10 != "-" && ("," $3 ",") ~ ("," key ",") { print $1; exit }' "$TMP/index.tab")"
  [ -n "$version" ] || die "no Node.js LTS build found for $OS-$ARCH"
  name="node-$version-$OS-$ARCH"
  step "Downloading Node.js $version ($OS-$ARCH) for GP Studio"
  fetch "https://nodejs.org/dist/$version/$name.tar.gz" "$TMP/$name.tar.gz"
  fetch "https://nodejs.org/dist/$version/SHASUMS256.txt" "$TMP/SHASUMS256.txt"
  expected="$(awk -v file="$name.tar.gz" '$2 == file { print $1 }' "$TMP/SHASUMS256.txt")"
  [ -n "$expected" ] && [ "$(sha256 "$TMP/$name.tar.gz")" = "$expected" ] ||
    die "the Node.js download is damaged (checksum mismatch); run the installer again"
  info "Checksum OK"
  rm -rf "$INSTALL_DIR/runtime/node"
  mkdir -p "$INSTALL_DIR/runtime/node"
  tar -xzf "$TMP/$name.tar.gz" -C "$INSTALL_DIR/runtime/node" --strip-components 1
  NODE="$INSTALL_DIR/runtime/node/bin/node"
  node_ok "$NODE" ||
    die "the downloaded Node.js does not run on this computer (it needs macOS 13.5 or newer); install Node.js 22 from https://nodejs.org/en/download and run the installer again"
}

NODE=""
PORTABLE="$INSTALL_DIR/runtime/node/bin/node"
if [ -x "$PORTABLE" ] && node_ok "$PORTABLE"; then
  NODE="$PORTABLE"
elif SYSTEM_NODE="$(command -v node 2>/dev/null)" && node_ok "$SYSTEM_NODE" && [ -x "$(dirname "$SYSTEM_NODE")/npm" ]; then
  NODE="$SYSTEM_NODE"
else
  install_node
fi
NODE_BIN="$(dirname "$NODE")"
info "Node.js $("$NODE" --version) at $NODE"

step "Installing the npm packages (Express, Socket.IO and ffmpeg for the CCTV cameras)"
(cd "$INSTALL_DIR" && PATH="$NODE_BIN:$PATH" "$NODE_BIN/npm" ci --no-audit --no-fund --no-update-notifier) ||
  die "npm could not install the packages. Check the internet connection and run the installer again."

FFMPEG="$(cd "$INSTALL_DIR" && "$NODE" -e "const c = require('./cctv.js'); const v = c.ffmpegVersion(c.findFfmpeg()); process.stdout.write(v ? v.text : '')" || true)"
if [ -n "$FFMPEG" ]; then
  info "ffmpeg $FFMPEG is ready for the CCTV cameras"
else
  warn "ffmpeg (needed only for CCTV cameras) could not be installed with the npm packages."
  if [ "$OS" = darwin ]; then warn "Install it with Homebrew: brew install ffmpeg"; else warn "Install it with: sudo apt install ffmpeg   (or your distribution's package manager)"; fi
fi

# ---------- launchers ----------

LAUNCHER="$INSTALL_DIR/Start-StreamStudio.command"
chmod +x "$LAUNCHER" "$INSTALL_DIR/setup/install.sh"

step "Adding GP Studio to the desktop"
if [ "$OS" = darwin ]; then
  DESKTOP_LAUNCHER="$HOME/Desktop/GP Studio.command"
  # the launcher from before the name GP Studio goes: this one replaces it
  rm -f "$HOME/Desktop/Stream Studio.command"
  if printf '#!/bin/bash\nexec "%s" "$@"\n' "$LAUNCHER" > "$DESKTOP_LAUNCHER" 2>/dev/null && chmod +x "$DESKTOP_LAUNCHER"; then
    info "Desktop: GP Studio (double-click it to start)"
  else
    warn "Could not write to the Desktop folder; start GP Studio with: $LAUNCHER"
  fi
else
  ENTRY="[Desktop Entry]
Type=Application
Name=GP Studio
Comment=Camera live screen: admin and program output
Exec=\"$LAUNCHER\"
Icon=$INSTALL_DIR/setup/stream-studio.png
Terminal=true
Categories=AudioVideo;Video;"
  mkdir -p "$HOME/.local/share/applications"
  printf '%s\n' "$ENTRY" > "$HOME/.local/share/applications/stream-studio.desktop"
  DESKTOP_DIR="$(xdg-user-dir DESKTOP 2>/dev/null || echo "$HOME/Desktop")"
  if [ -d "$DESKTOP_DIR" ]; then
    printf '%s\n' "$ENTRY" > "$DESKTOP_DIR/stream-studio.desktop"
    chmod +x "$DESKTOP_DIR/stream-studio.desktop"
    gio set "$DESKTOP_DIR/stream-studio.desktop" metadata::trusted true 2>/dev/null || true
  fi
  info "Applications menu and desktop: GP Studio"
fi

# ---------- start at log-in (in the background, no browser) ----------

if [ "$OS" = darwin ]; then
  AUTOFILE="$HOME/Library/LaunchAgents/com.streamstudio.server.plist"
else
  AUTOFILE="${XDG_CONFIG_HOME:-$HOME/.config}/autostart/stream-studio.desktop"
fi
AUTO="${STREAM_STUDIO_AUTOSTART:-}"
if [ -z "$AUTO" ]; then
  if [ -f "$AUTOFILE" ]; then
    AUTO="$(ask 'Start GP Studio automatically when you log in? [Y/n]' y)"
  else
    AUTO="$(ask 'Start GP Studio automatically when you log in? [y/N]' n)"
  fi
fi
case "$AUTO" in
  [yY]*)
    mkdir -p "$(dirname "$AUTOFILE")"
    # node by its full path: log-in services do not get the PATH of a terminal (Homebrew, nvm)
    if [ "$OS" = darwin ]; then
      mkdir -p "$HOME/Library/Logs"
      cat > "$AUTOFILE" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.streamstudio.server</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>$INSTALL_DIR/server.js</string></array>
  <key>WorkingDirectory</key><string>$INSTALL_DIR</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>$NODE_BIN:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/StreamStudio.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/StreamStudio.log</string>
</dict>
</plist>
EOF
      info "GP Studio starts in the background from your next log-in (log: ~/Library/Logs/StreamStudio.log)."
    else
      cat > "$AUTOFILE" <<EOF
[Desktop Entry]
Type=Application
Name=GP Studio
Comment=Starts the GP Studio server in the background
Exec="$NODE" "$INSTALL_DIR/server.js"
Path=$INSTALL_DIR
Terminal=false
X-GNOME-Autostart-enabled=true
EOF
      info "GP Studio starts in the background from your next log-in."
    fi
    ;;
  *)
    if [ -f "$AUTOFILE" ]; then
      rm -f "$AUTOFILE"
      info "GP Studio no longer starts at log-in."
    fi
    ;;
esac

# ---------- done ----------

PORT="$(port_of "$INSTALL_DIR")"
step "GP Studio is installed"
info "Folder : $INSTALL_DIR"
if [ "$OS" = darwin ]; then
  info 'Start  : double-click "GP Studio" on the desktop'
else
  info 'Start  : "GP Studio" in the applications menu or on the desktop'
fi
info "Admin  : http://localhost:$PORT/admin/"
info "Output : http://localhost:$PORT/output/"
if [ "$OS" = darwin ]; then
  info "macOS asks once to let the browser use the camera, and to let Terminal reach devices on your"
  info "local network (CCTV cameras): allow both."
fi

if [ "${STREAM_STUDIO_START:-}" != no ]; then
  case "$(ask 'Start GP Studio now? [Y/n]' y)" in
    [nN]*) ;;
    *)
      step "Starting GP Studio (close this window or press Ctrl+C to stop it)"
      rm -rf "$TMP"
      trap - EXIT
      exec "$LAUNCHER"
      ;;
  esac
fi
exit 0
}
