#!/usr/bin/env bash
# One-shot setup on Linux (X11 session; Ubuntu 22.04 and 24.04). No root needed, nothing is installed
# system-wide: Node.js (when needed) goes into ./tools/node, Electron and koffi into ./host/node_modules.
# start-host.sh and start-client.sh run it by themselves on their first start (without the self-test).
#   ./setup.sh [--skip-selftest] [--hold]
# 1. Uses Node.js >= 22.12 (what Electron 45's npm package needs) with npm: one downloaded into ./tools/node
#    earlier, else the one on PATH, else downloads portable Node 22 LTS into ./tools/node (SHA-256
#    verified), as setup.ps1 does on Windows. Ubuntu's own nodejs package is too old (22.04: 12, 24.04: 18).
# 2. Runs npm install in ./host (Electron, koffi) and fetches Electron's program.
# 3. Where Chromium's sandbox is restricted (Ubuntu 23.10 and later), offers to install its helper (sudo).
# 4. Adds "Pangmote Host" and "Pangmote Client" to this user's app menu (in place of "My Remote Host" and
#    "My Remote Client", which this folder's setup added before the program was renamed in 0.10.0).
# 5. Runs the self-test. It is fully local: no internet traffic, throwaway key, no input injected.
# --hold: in a terminal window of its own (a start from the file manager), wait before it closes.
set -euo pipefail
. "$(dirname "$0")/host/linux-launch.sh"

skip=0 hold=0
for a in "$@"; do
  case "$a" in --skip-selftest) skip=1 ;; --hold) hold=1 ;; esac
done
if [ "$(uname -s)" != "Linux" ]; then
  echo "[setup] This script is for Linux. On Windows run setup.ps1." >&2
  exit 1
fi
[ -n "${PANGMOTE_SETUP_MARK:-}" ] && echo started > "$PANGMOTE_SETUP_MARK" # the launcher's terminal window did run this
tmp=""
finish() {
  local status=$?
  [ -n "$tmp" ] && rm -rf "$tmp"
  if [ "$hold" = 1 ]; then
    if [ "$status" = 0 ]; then sleep 2; else echo; read -r -p "[setup] It did not finish (see above). Press Enter to close this window. " _ || true; fi
  fi
}
trap finish EXIT

# Node.js >= 22.12 with npm. PANGMOTE_NODE_DIST (or MY_REMOTE_NODE_DIST) points the download elsewhere (tests).
nodedir="$root/tools/node"
node_ok() { [ -n "$1" ] && [ -x "$1" ] && [ "$("$1" -p 'const [a, b] = process.versions.node.split(".").map(Number); a > 22 || (a === 22 && b >= 12) ? 1 : 0' 2>/dev/null)" = 1 ]; }
fetch() { # url file: curl, or wget (what a fresh Ubuntu desktop has)
  if command -v curl >/dev/null 2>&1; then curl -fsSL "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then wget -q "$1" -O "$2"
  else echo "[setup] Neither curl nor wget is installed (sudo apt install wget)." >&2; return 1; fi
}
if [ -e "$nodedir/bin/node" ]; then
  if ! node_ok "$nodedir/bin/node"; then
    echo "[setup] tools/node holds Node $("$nodedir/bin/node" -v 2>/dev/null || echo '?'), older than 22.12. Delete the tools/node folder and run ./setup.sh again." >&2
    exit 1
  fi
  PATH="$nodedir/bin:$PATH"
elif ! { command -v npm >/dev/null 2>&1 && node_ok "$(command -v node 2>/dev/null || true)"; }; then
  case "$(uname -m)" in
    x86_64) arch=x64 ;; aarch64|arm64) arch=arm64 ;; armv7l) arch=armv7l ;;
    *) echo "[setup] There is no portable Node.js for this processor ($(uname -m)): install Node.js 22.12 or newer with npm, then run this again." >&2; exit 1 ;;
  esac
  dist="${PANGMOTE_NODE_DIST:-${MY_REMOTE_NODE_DIST:-https://nodejs.org/dist}}/latest-v22.x"
  echo "[setup] Node.js 22.12 or newer not found (found: $(node -v 2>/dev/null || echo none)) - downloading portable Node 22 LTS into tools/node"
  mkdir -p "$root/tools"
  tmp="$(mktemp -d "$root/tools/.node-download.XXXXXX")"
  fetch "$dist/SHASUMS256.txt" "$tmp/sums" || { echo "[setup] Could not download the list of Node.js builds from $dist." >&2; exit 1; }
  line="$(grep -E "^[0-9a-f]{64}  node-v22\.[0-9]+\.[0-9]+-linux-$arch\.tar\.gz$" "$tmp/sums" | head -n 1 || true)"
  [ -n "$line" ] || { echo "[setup] $dist has no Node 22 build for linux-$arch." >&2; exit 1; }
  hash="${line%% *}"; name="${line##* }"
  fetch "$dist/$name" "$tmp/$name" || { echo "[setup] Downloading $name failed." >&2; exit 1; }
  if [ "$(sha256sum "$tmp/$name" | cut -d ' ' -f 1)" != "$hash" ]; then
    echo "[setup] $name does not match its SHA-256 in $dist/SHASUMS256.txt; nothing was installed." >&2
    exit 1
  fi
  tar -xzf "$tmp/$name" -C "$tmp"
  rm -rf "$nodedir"
  mv "$tmp/${name%.tar.gz}" "$nodedir"
  PATH="$nodedir/bin:$PATH"
fi
export PATH
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

# Ubuntu 23.10 and later: Chromium's sandbox needs its helper installed by root. Asked here, once.
if ! sandbox_ok && [ "$no_sandbox" != 1 ] && [ -t 0 ]; then
  echo "[setup] This system restricts what Chromium's sandbox needs (Ubuntu 23.10 and later). Electron's"
  echo "        sandbox helper can be installed once with sudo (recommended); otherwise the programs must"
  echo "        be started with PANGMOTE_NO_SANDBOX=1 (without the sandbox)."
  read -r -p "[setup] Install the sandbox helper now with sudo? [Y/n] " answer || answer=n
  case "$answer" in
    [Nn]*) echo "[setup] Not installed. Start the programs with PANGMOTE_NO_SANDBOX=1 in front, e.g. PANGMOTE_NO_SANDBOX=1 ./start-host.sh" ;;
    *) sudo chown root:root "$sandbox_helper" && sudo chmod 4755 "$sandbox_helper" && echo "[setup] Sandbox helper installed." ;;
  esac
fi

# This user's app menu: later starts are one click. (Delete the two files to take them out again.)
apps="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
case "$root" in
  *[\"\`\$\\%]*) echo "[setup] The folder's path has a character an app menu entry cannot hold; start the programs with the .sh files." ;;
  *)
    if mkdir -p "$apps" 2>/dev/null; then
      for kind in host client; do
        if [ "$kind" = host ]; then title="Pangmote Host"; what="Lets another PC see and control this PC"; else title="Pangmote Client"; what="Shows and controls another PC"; fi
        printf '%s\n' '[Desktop Entry]' 'Type=Application' "Name=$title" "Comment=$what" "Exec=\"$root/start-$kind.sh\"" \
          "Icon=$root/host/icon.svg" 'Terminal=false' 'Categories=Network;RemoteAccess;' > "$apps/pangmote-$kind.desktop"
        # The entry of the old name, when it is this folder's own (another folder's stays).
        old="$apps/my-remote-$kind.desktop"
        if [ -f "$old" ] && grep -qF "Exec=\"$root/start-$kind.sh\"" "$old"; then rm -f "$old"; fi
      done
      echo "[setup] Added \"Pangmote Host\" and \"Pangmote Client\" to the app menu ($apps)"
    fi
    ;;
esac

if [ "$skip" = 0 ]; then
  check_session
  check_sandbox
  log="${XDG_RUNTIME_DIR:-${TMPDIR:-/tmp}}/pangmote-selftest.log"
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
if [ "${PANGMOTE_FROM_LAUNCHER:-}" = 1 ]; then exit 0; fi # the launcher that ran this starts the program now
echo "  Start the host : ./start-host.sh    (or \"Pangmote Host\" in the app menu)"
echo "  Try it locally : ./local-test.sh    (view-only, no internet traffic)"
echo "  Client app     : ./start-client.sh  (on the PC you connect FROM; or \"Pangmote Client\" in the app menu)"
echo "  Client, no install: pangmote-client.html (open in Chrome, Edge or Chromium on the other PC)"
