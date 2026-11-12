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
