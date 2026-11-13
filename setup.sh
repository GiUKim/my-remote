#!/usr/bin/env bash
# One-shot setup on Linux (X11 session; Ubuntu 22.04 tested). No root needed, nothing is installed
# system-wide and nothing is downloaded but what npm install fetches for host/ (Electron and koffi).
#   ./setup.sh [--skip-selftest]
# 1. Uses Node.js >= 20 with npm from PATH; says what to install when there is none.
# 2. Runs npm install in ./host.
# 3. Runs the self-test. It is fully local: no internet traffic, throwaway key, no input injected.
set -euo pipefail
. "$(dirname "$0")/host/linux-launch.sh"

skip=0
[ "${1:-}" = "--skip-selftest" ] && skip=1
if [ "$(uname -s)" != "Linux" ]; then
  echo "[setup] This script is for Linux. On Windows run setup.ps1." >&2
  exit 1
fi

major=0
if command -v node >/dev/null 2>&1; then major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"; fi
if [ "$major" -lt 20 ] || ! command -v npm >/dev/null 2>&1; then
  echo "[setup] Node.js 20 or newer, with npm, is needed (found: $(node -v 2>/dev/null || echo none))." >&2
  echo "        Install the LTS version from https://nodejs.org or your distribution's packages" >&2
  echo "        (Ubuntu 22.04's own nodejs package is too old), then run this again." >&2
  exit 1
fi
echo "[setup] Node $(node -v) at $(command -v node)"

# The host's input and cursor go through these X11 libraries; without them it runs view-only.
libs="$( { ldconfig -p || /sbin/ldconfig -p; } 2>/dev/null || true)"
missing=""
for lib in libX11.so.6 libXtst.so.6 libXfixes.so.3; do
  grep -q "$lib" <<<"$libs" || missing="$missing $lib"
done
[ -z "$missing" ] || echo "[setup] Missing:$missing (Ubuntu/Debian: sudo apt install libx11-6 libxtst6 libxfixes3). Without them the host is view-only."

echo "[setup] npm install (downloads Electron, about 100 MB)"
(cd "$root/host" && npm install --no-fund --no-audit)
# npm install no longer fetches Electron's program itself (seen with Electron 45; it would come at
# first start through the npm package); fetch it now (checksums verified by @electron/get), so that
# the launchers, which start dist/electron directly, find it.
(cd "$root/host" && node node_modules/electron/install.js)
need_electron

if [ "$skip" = 0 ]; then
  check_session
  check_sandbox
  log="${XDG_RUNTIME_DIR:-${TMPDIR:-/tmp}}/my-remote-selftest.log"
  echo "[setup] Running local self-test (about 1 minute; captures the screen locally, sends nothing out)"
  status=0
  (umask 077; timeout 300 "$electron" "${sandbox_args[@]}" "$root/host" --selftest >"$log" 2>&1) || status=$?
  grep '\[selftest\]' "$log" || true
  if [ "$status" != 0 ]; then
    echo "[setup] Self-test failed (exit code $status). Full log: $log" >&2
    exit 1
  fi
fi

echo
echo "[setup] Done."
echo "  Start the host : ./start-host.sh"
echo "  Try it locally : ./local-test.sh    (view-only, no internet traffic)"
echo "  Client app     : ./start-client.sh  (on the PC you connect FROM; one-click multi-monitor layout)"
echo "  Client, no install: my-remote-client.html (open in Chrome, Edge or Chromium on the other PC)"
