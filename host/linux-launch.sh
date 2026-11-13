# Shared by setup.sh, start-host.sh, start-client.sh and local-test.sh (Linux). Sourced, not run.
# Electron is the one npm installed under host/node_modules (setup.sh).

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
electron="$root/host/node_modules/electron/dist/electron"
# Terminals inside VS Code / Cursor set this; with it Electron runs as plain Node and the app cannot start.
unset ELECTRON_RUN_AS_NODE

need_electron() {
  if [ ! -x "$electron" ]; then
    echo "Electron is not installed under host/node_modules. Run ./setup.sh first." >&2
    exit 1
  fi
  check_libs
}

# Electron links the desktop's libraries (GTK 3, NSS, ALSA, GBM, AT-SPI, ...; checked with Electron 45):
# on a system without a desktop, or a minimal one, it does not start at all ("error while loading
# shared libraries"). Says which are missing and how to install them.
check_libs() {
  local missing
  missing="$(ldd "$electron" 2>/dev/null | awk '/not found/ {print $1}' | sort -u | tr '\n' ' ')"
  [ -z "$missing" ] && return 0
  echo "Electron cannot start: these libraries are missing: $missing" >&2
  if command -v apt-get >/dev/null 2>&1; then
    local pkgs="" l p
    for l in $missing; do
      case "$l" in
        libgtk-3.so*|libgdk-3.so*) p=libgtk-3-0 ;; libgdk_pixbuf-2.0.so*) p=libgdk-pixbuf-2.0-0 ;;
        libnss3.so|libnssutil3.so|libsmime3.so) p=libnss3 ;; libnspr4.so|libplc4.so|libplds4.so) p=libnspr4 ;;
        libasound.so*) p=libasound2 ;; libgbm.so*) p=libgbm1 ;; libdrm.so*) p=libdrm2 ;; libxkbcommon.so*) p=libxkbcommon0 ;;
        libatk-1.0.so*) p=libatk1.0-0 ;; libatk-bridge-2.0.so*) p=libatk-bridge2.0-0 ;; libatspi.so*) p=libatspi2.0-0 ;;
        libcups.so*) p=libcups2 ;; libdbus-1.so*) p=libdbus-1-3 ;; libexpat.so*) p=libexpat1 ;;
        libglib-2.0.so*|libgobject-2.0.so*|libgio-2.0.so*) p=libglib2.0-0 ;; libpango-1.0.so*) p=libpango-1.0-0 ;; libcairo.so*) p=libcairo2 ;;
        libX11.so*) p=libx11-6 ;; libxcb.so*) p=libxcb1 ;; libXext.so*) p=libxext6 ;; libXfixes.so*) p=libxfixes3 ;;
        libXcomposite.so*) p=libxcomposite1 ;; libXdamage.so*) p=libxdamage1 ;; libXrandr.so*) p=libxrandr2 ;; libXtst.so*) p=libxtst6 ;;
        *) continue ;;
      esac
      apt-cache show "${p}t64" >/dev/null 2>&1 && p="${p}t64" # Ubuntu 24.04 and Debian 13 renamed many of them
      case " $pkgs " in *" $p "*) ;; *) pkgs="$pkgs $p" ;; esac
    done
    [ -n "$pkgs" ] && echo "Install them with: sudo apt install$pkgs" >&2
  elif command -v dnf >/dev/null 2>&1 || command -v zypper >/dev/null 2>&1; then
    local caps="" l
    for l in $missing; do caps="$caps '$l()(64bit)'"; done
    echo "Install them with: sudo $(command -v dnf >/dev/null 2>&1 && echo dnf || echo zypper) install$caps" >&2
  elif command -v pacman >/dev/null 2>&1; then
    echo "Install them with: sudo pacman -S --needed gtk3 nss alsa-lib mesa libxkbcommon at-spi2-core libcups libxtst" >&2
  fi
  exit 1
}

# Only X11 sessions are supported: on Wayland, capturing the screen and injecting input go through the
# desktop's portals, which this program does not use. (Electron would still start, through Xwayland.)
check_session() {
  if [ "${XDG_SESSION_TYPE:-}" = "wayland" ]; then
    echo "This is a Wayland session, which My Remote does not support. Log in with an X11 session" >&2
    echo "(on the login screen: the gear icon -> \"Ubuntu on Xorg\" or similar) and run this again." >&2
    exit 1
  fi
  if [ -z "${DISPLAY:-}" ]; then
    echo "No X11 display (DISPLAY is not set). Run this from the desktop session of this PC." >&2
    exit 1
  fi
}

# Chromium's sandbox needs either its setuid helper (chrome-sandbox owned by root, mode 4755: npm does
# not install it that way) or unprivileged user namespaces, which Ubuntu 22.04 allows and Ubuntu 23.10
# and later restrict through AppArmor. Where neither is available Electron cannot start with the
# sandbox; it then runs without it only when the person says so (MY_REMOTE_NO_SANDBOX=1).
sandbox_args=()
check_sandbox() {
  local helper="$root/host/node_modules/electron/dist/chrome-sandbox"
  if [ -u "$helper" ] && [ "$(stat -c %u "$helper")" = 0 ]; then return; fi
  local clone restrict
  clone="$(cat /proc/sys/kernel/unprivileged_userns_clone 2>/dev/null || echo 1)"
  restrict="$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)"
  if [ "$clone" = 1 ] && [ "$restrict" = 0 ]; then return; fi
  if [ "${MY_REMOTE_NO_SANDBOX:-}" = 1 ]; then
    echo "Running Electron without Chromium's sandbox (MY_REMOTE_NO_SANDBOX=1)." >&2
    sandbox_args=(--no-sandbox)
    return
  fi
  echo "This system restricts what Chromium's sandbox needs (unprivileged user namespaces), and" >&2
  echo "Electron's sandbox helper is not installed. Either install the helper once (needs sudo):" >&2
  echo "  sudo chown root:root \"$helper\" && sudo chmod 4755 \"$helper\"" >&2
  echo "or run without the sandbox: MY_REMOTE_NO_SANDBOX=1 $0" >&2
  exit 1
}

# Starts Electron in the background, as the .bat files do on Windows; its output goes to a log file
# that only this user can read. launch <log name> <electron arguments...>
launch() {
  local log="${XDG_RUNTIME_DIR:-${TMPDIR:-/tmp}}/$1.log"
  shift
  (umask 077; exec setsid "$electron" "${sandbox_args[@]}" "$@" >"$log" 2>&1 </dev/null) &
  local pid=$! status=0
  sleep 3
  if kill -0 "$pid" 2>/dev/null; then
    echo "Started. Output: $log"
    return
  fi
  wait "$pid" || status=$?
  if [ "$status" = 0 ]; then
    # The host runs once per user: a second start shows the running one's window and ends.
    echo "It was already running; its window has been brought up."
  else
    echo "It stopped right away (exit code $status). The end of its output ($log):" >&2
    tail -n 20 "$log" >&2
    exit 1
  fi
}
