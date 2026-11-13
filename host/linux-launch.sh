# Shared by setup.sh, start-host.sh, start-client.sh and local-test.sh (Linux). Sourced, not run.
# Electron is the one npm installed under host/node_modules (setup.sh).

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
electron="$root/host/node_modules/electron/dist/electron"
# Terminals inside VS Code / Cursor set this; with it Electron runs as plain Node and the app cannot start.
unset ELECTRON_RUN_AS_NODE

# An error, also for a person who started this from the app menu or the file manager (no terminal):
# then in a dialog (zenity, which Ubuntu has) or a notification. fail <lines...>
fail() {
  printf '%s\n' "$@" >&2
  if [ ! -t 2 ] && [ -n "${DISPLAY:-}" ]; then
    if command -v zenity >/dev/null 2>&1; then zenity --error --title="My Remote" --no-wrap --text="$(printf '%s\n' "$@")" >/dev/null 2>&1 || true
    elif command -v notify-send >/dev/null 2>&1; then notify-send "My Remote" "$(printf '%s\n' "$@")" >/dev/null 2>&1 || true; fi
  fi
  exit 1
}

need_electron() {
  [ -x "$electron" ] || fail "Electron is not installed under host/node_modules. Run ./setup.sh first."
  check_libs
}

# The first start sets this folder up (setup.sh without its self-test, a few minutes): from the downloaded
# zip to a running program is one command, or one "Run as a Program" in the file manager. Without a
# terminal the setup runs in a terminal window of its own, so that its progress can be seen.
ensure_setup() {
  if [ ! -x "$electron" ]; then
    echo "First start: setting this folder up (Node.js if needed, then Electron; a few minutes)"
    if [ -t 1 ]; then
      MY_REMOTE_FROM_LAUNCHER=1 bash "$root/setup.sh" --skip-selftest || fail "Setup did not finish; see the messages above."
    else
      # A terminal window of its own; setup.sh marks that it ran (a window that cannot open - no desktop
      # session - runs nothing, and then it runs here, into a log).
      local mark ran=""
      mark="$(mktemp)"
      if [ -n "${DISPLAY:-}" ] && command -v gnome-terminal >/dev/null 2>&1; then
        gnome-terminal --wait --title="My Remote setup" -- env MY_REMOTE_FROM_LAUNCHER=1 MY_REMOTE_SETUP_MARK="$mark" bash "$root/setup.sh" --skip-selftest --hold >/dev/null 2>&1 || true
        ran="$(cat "$mark" 2>/dev/null || true)"
      fi
      rm -f "$mark"
      if [ -z "$ran" ]; then
        local log="${XDG_RUNTIME_DIR:-${TMPDIR:-/tmp}}/my-remote-setup.log"
        (umask 077; MY_REMOTE_FROM_LAUNCHER=1 bash "$root/setup.sh" --skip-selftest >"$log" 2>&1) || fail "Setup did not finish. Its messages: $log" "Or run ./setup.sh in a terminal."
      fi
    fi
    [ -x "$electron" ] || fail "Setup did not finish. Run ./setup.sh in a terminal to see why."
  fi
  check_libs
}

# Electron links the desktop's libraries (GTK 3, NSS, ALSA, GBM, AT-SPI, ...; checked with Electron 45):
# on a system without a desktop, or a minimal one, it does not start at all ("error while loading
# shared libraries"). Says which are missing and how to install them.
check_libs() {
  local missing hint=""
  missing="$(ldd "$electron" 2>/dev/null | awk '/not found/ {print $1}' | sort -u | tr '\n' ' ')"
  [ -z "$missing" ] && return 0
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
    [ -n "$pkgs" ] && hint="Install them with: sudo apt install$pkgs"
  elif command -v dnf >/dev/null 2>&1 || command -v zypper >/dev/null 2>&1; then
    local caps="" l
    for l in $missing; do caps="$caps '$l()(64bit)'"; done
    hint="Install them with: sudo $(command -v dnf >/dev/null 2>&1 && echo dnf || echo zypper) install$caps"
  elif command -v pacman >/dev/null 2>&1; then
    hint="Install them with: sudo pacman -S --needed gtk3 nss alsa-lib mesa libxkbcommon at-spi2-core libcups libxtst"
  fi
  fail "Electron cannot start: these libraries are missing: $missing" ${hint:+"$hint"}
}

# Only X11 sessions are supported: on Wayland, capturing the screen and injecting input go through the
# desktop's portals, which this program does not use. (Electron would still start, through Xwayland.)
check_session() {
  if [ "${XDG_SESSION_TYPE:-}" = "wayland" ]; then
    fail "This is a Wayland session, which My Remote does not support. Log out, and on the login" \
      "screen pick \"Ubuntu on Xorg\" (the gear icon at the bottom right, after choosing your name), then start it again."
  fi
  [ -n "${DISPLAY:-}" ] || fail "No X11 display (DISPLAY is not set). Run this from the desktop session of this PC."
}

# Chromium's sandbox needs either its setuid helper (chrome-sandbox owned by root, mode 4755: npm does
# not install it that way) or unprivileged user namespaces, which Ubuntu 22.04 allows and Ubuntu 23.10
# and later restrict through AppArmor. Where neither is available Electron cannot start with the
# sandbox; it then runs without it only when the person says so (MY_REMOTE_NO_SANDBOX=1).
sandbox_args=()
sandbox_helper="$root/host/node_modules/electron/dist/chrome-sandbox"
sandbox_ok() { # 0: Chromium's sandbox can run here
  if [ -u "$sandbox_helper" ] && [ "$(stat -c %u "$sandbox_helper")" = 0 ]; then return 0; fi
  local clone restrict
  clone="$(cat /proc/sys/kernel/unprivileged_userns_clone 2>/dev/null || echo 1)"
  restrict="$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)"
  [ "$clone" = 1 ] && [ "$restrict" = 0 ]
}
check_sandbox() {
  sandbox_ok && return
  if [ "${MY_REMOTE_NO_SANDBOX:-}" = 1 ]; then
    echo "Running Electron without Chromium's sandbox (MY_REMOTE_NO_SANDBOX=1)." >&2
    sandbox_args=(--no-sandbox)
    return
  fi
  fail "This system restricts what Chromium's sandbox needs (unprivileged user namespaces; Ubuntu 23.10 and" \
    "later), and Electron's sandbox helper is not installed. Either install the helper once (needs sudo;" \
    "./setup.sh offers to do it):" \
    "  sudo chown root:root \"$sandbox_helper\" && sudo chmod 4755 \"$sandbox_helper\"" \
    "or run without the sandbox: MY_REMOTE_NO_SANDBOX=1 $0"
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
    local last
    last="$(tail -n 12 "$log" 2>/dev/null || true)"
    fail "It stopped right away (exit code $status). The end of its output ($log):" "$last"
  fi
}
