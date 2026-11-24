# Shared by setup.sh, start-host.sh, start-client.sh and local-test.sh (Linux). Sourced, not run.
# Electron is the one npm installed under host/node_modules (setup.sh).

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# The installed app (app/pangmote.sh) names its own program and has no folder to pass (mr_app).
# (MY_REMOTE_*: the names of these settings before the program was renamed in 0.10.0; still taken.)
electron="${PANGMOTE_ELECTRON:-${MY_REMOTE_ELECTRON:-$root/host/node_modules/electron/dist/electron}}"
no_sandbox="${PANGMOTE_NO_SANDBOX:-${MY_REMOTE_NO_SANDBOX:-}}"
mr_app=("$root/host")
# Terminals inside VS Code / Cursor set this; with it Electron runs as plain Node and the app cannot start.
unset ELECTRON_RUN_AS_NODE

# An error, also for a person who started this from the app menu or the file manager (no terminal):
# then in a dialog (zenity, which Ubuntu has) or a notification. fail <lines...>
fail() {
  printf '%s\n' "$@" >&2
  if [ ! -t 2 ] && [ -n "${DISPLAY:-}" ]; then
    if command -v zenity >/dev/null 2>&1; then zenity --error --title="Pangmote" --no-wrap --text="$(printf '%s\n' "$@")" >/dev/null 2>&1 || true
    elif command -v notify-send >/dev/null 2>&1; then notify-send "Pangmote" "$(printf '%s\n' "$@")" >/dev/null 2>&1 || true; fi
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
      PANGMOTE_FROM_LAUNCHER=1 bash "$root/setup.sh" --skip-selftest || fail "Setup did not finish; see the messages above."
    else
      # A terminal window of its own; setup.sh marks that it ran (a window that cannot open - no desktop
      # session - runs nothing, and then it runs here, into a log).
      local mark ran=""
      mark="$(mktemp)"
      if [ -n "${DISPLAY:-}" ] && command -v gnome-terminal >/dev/null 2>&1; then
        gnome-terminal --wait --title="Pangmote setup" -- env PANGMOTE_FROM_LAUNCHER=1 PANGMOTE_SETUP_MARK="$mark" bash "$root/setup.sh" --skip-selftest --hold >/dev/null 2>&1 || true
        ran="$(cat "$mark" 2>/dev/null || true)"
      fi
      rm -f "$mark"
      if [ -z "$ran" ]; then
        local log="${XDG_RUNTIME_DIR:-${TMPDIR:-/tmp}}/pangmote-setup.log"
        (umask 077; PANGMOTE_FROM_LAUNCHER=1 bash "$root/setup.sh" --skip-selftest >"$log" 2>&1) || fail "Setup did not finish. Its messages: $log" "Or run ./setup.sh in a terminal."
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
# Started over ssh (no display in the terminal, or only the ssh client's forwarded one, which is not this
# PC's screen), it runs on the desktop session this user is logged in to on this PC, as if started there.
check_session() {
  local disp="${DISPLAY:-}" r=0
  if [ -n "${SSH_CONNECTION:-}" ] && [ -n "${disp%%:*}" ] && [ "${disp%%:*}" != unix ]; then disp=""; fi # localhost:10.0
  if [ -z "$disp" ]; then
    desktop_env || r=$?
    [ "$r" = 2 ] && fail "You are logged in at this PC's desktop with Wayland, which Pangmote does not support. Log out there," \
      "and on the login screen pick \"Ubuntu on Xorg\" (the gear icon at the bottom right, after choosing your name)."
    [ "$r" = 0 ] || fail "No desktop to run on: this terminal has no display, and you ($(id -un)) are not logged in at this PC's" \
      "desktop. Log in there first (on Ubuntu pick \"Ubuntu on Xorg\" on the login screen), then run this again."
    echo "No display in this terminal: starting on the desktop you are logged in to on this PC (display $DISPLAY)."
  fi
  if [ "${XDG_SESSION_TYPE:-}" = "wayland" ]; then
    fail "This is a Wayland session, which Pangmote does not support. Log out, and on the login" \
      "screen pick \"Ubuntu on Xorg\" (the gear icon at the bottom right, after choosing your name), then start it again."
  fi
}

# This user's graphical session on this PC (logind): exports its DISPLAY, XAUTHORITY, session bus and
# desktop variables, read from a process of that session. 1: there is none; 2: there is one, on Wayland.
desktop_env() {
  local uid s u t c st d k v p envs="" found="" var val
  uid="$(id -u)"
  command -v loginctl >/dev/null 2>&1 || return 1
  while read -r s u _; do
    [ "$u" = "$uid" ] || continue
    t=""; c=""; st=""; d=""
    while IFS='=' read -r k v; do
      case "$k" in Type) t="$v" ;; Class) c="$v" ;; State) st="$v" ;; Display) d="$v" ;; esac
    done < <(loginctl show-session "$s" -p Type -p Class -p State -p Display 2>/dev/null)
    { [ "$c" = user ] && [ "$st" != closing ]; } || continue
    case "$t" in x11) found="$s"; break ;; wayland) found=wayland ;; esac
  done < <(loginctl list-sessions --no-legend 2>/dev/null)
  [ "$found" = wayland ] && return 2
  [ -n "$found" ] || return 1
  # A process of that session (its cgroup is the session's scope) knows the display's authority file,
  # which display managers put in different places.
  for p in $(pgrep -u "$uid" 2>/dev/null); do
    grep -q "/session-$found\.scope" "/proc/$p/cgroup" 2>/dev/null || continue
    envs="$(tr '\0' '\n' < "/proc/$p/environ" 2>/dev/null)" || continue
    printf '%s\n' "$envs" | grep -q '^DISPLAY=' && break
    envs=""
  done
  for var in DISPLAY XAUTHORITY DBUS_SESSION_BUS_ADDRESS XDG_CURRENT_DESKTOP XDG_SESSION_DESKTOP DESKTOP_SESSION GDMSESSION XCURSOR_THEME XCURSOR_SIZE; do
    val="$(printf '%s\n' "$envs" | sed -n "s/^$var=//p" | head -n 1)"
    if [ -n "$val" ]; then export "$var=$val"; fi
  done
  if [ -z "$envs" ]; then # no process to read: what logind and the usual places say
    [ -n "$d" ] || return 1
    export DISPLAY="$d"
    if [ -f "/run/user/$uid/gdm/Xauthority" ]; then export XAUTHORITY="/run/user/$uid/gdm/Xauthority"
    elif [ -f "$HOME/.Xauthority" ]; then export XAUTHORITY="$HOME/.Xauthority"; fi
  fi
  [ -n "${DISPLAY:-}" ] || return 1
  export XDG_SESSION_TYPE=x11
  unset WAYLAND_DISPLAY
}

# Chromium's sandbox needs either its setuid helper (chrome-sandbox owned by root, mode 4755: npm does
# not install it that way) or unprivileged user namespaces, which Ubuntu 22.04 allows and Ubuntu 23.10
# and later restrict through AppArmor. Where neither is available Electron cannot start with the
# sandbox; it then runs without it only when the person says so (PANGMOTE_NO_SANDBOX=1).
sandbox_args=()
sandbox_helper="$(dirname "$electron")/chrome-sandbox"
sandbox_ok() { # 0: Chromium's sandbox can run here
  if [ -u "$sandbox_helper" ] && [ "$(stat -c %u "$sandbox_helper")" = 0 ]; then return 0; fi
  local clone restrict
  clone="$(cat /proc/sys/kernel/unprivileged_userns_clone 2>/dev/null || echo 1)"
  restrict="$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)"
  [ "$clone" = 1 ] && [ "$restrict" = 0 ]
}
check_sandbox() {
  sandbox_ok && return
  if [ "$no_sandbox" = 1 ]; then
    echo "Running Electron without Chromium's sandbox (PANGMOTE_NO_SANDBOX=1)." >&2
    sandbox_args=(--no-sandbox)
    return
  fi
  fail "This system restricts what Chromium's sandbox needs (unprivileged user namespaces; Ubuntu 23.10 and" \
    "later), and Electron's sandbox helper is not installed. Either install the helper once (needs sudo;" \
    "./setup.sh offers to do it):" \
    "  sudo chown root:root \"$sandbox_helper\" && sudo chmod 4755 \"$sandbox_helper\"" \
    "or run without the sandbox: PANGMOTE_NO_SANDBOX=1 $0"
}

# ./start-host.sh --show-key: prints the access key in this terminal, for a host reached over ssh (its
# window, with the 키 복사 button, is on a screen nobody sits at). In the foreground, and never into a log
# file: the key goes to stdout only. No display is used (an ssh client's X11 forwarding is left alone);
# a desktop session's keyring is reached through the user's session bus, as from a terminal on that desktop.
show_key() {
  [ -x "$electron" ] || fail "Pangmote is not set up in this folder yet: run ./start-host.sh on this PC's desktop first."
  check_libs
  # It opens no window and loads no page, so Chromium's sandbox guards nothing here: where it cannot run
  # (Ubuntu 23.10 and later without its helper), this runs without it instead of stopping.
  sandbox_ok || sandbox_args=(--no-sandbox)
  local bus="${DBUS_SESSION_BUS_ADDRESS:-}" run="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
  [ -z "$bus" ] && [ -S "$run/bus" ] && bus="unix:path=$run/bus"
  # A key that is only obscured ("v10", its encrypted form starts with "djEw") needs no keyring. Electron
  # asks one anyway when the bus has one, and a keyring that cannot be unlocked from here (its password
  # prompt needs a display) answers only after D-Bus's time-out of 25 s: such a key is read without the bus.
  grep -q '"keyEnc": *"djEw' "${XDG_CONFIG_HOME:-$HOME/.config}/my-remote-host/config.json" 2>/dev/null && bus="unix:path=/dev/null/none"
  local err status=0
  err="$(mktemp)"
  # The engine's own messages (no display, no GPU) are left out; the app's are marked [show-key].
  env -u DISPLAY -u WAYLAND_DISPLAY ${bus:+DBUS_SESSION_BUS_ADDRESS="$bus"} \
    "$electron" "${sandbox_args[@]}" --ozone-platform=headless --disable-gpu "${mr_app[@]}" --show-key 2>"$err" </dev/null || status=$?
  if grep -q '^\[show-key\] ' "$err"; then
    sed -n 's/^\[show-key\] //p' "$err" >&2
  elif [ "$status" != 0 ]; then
    echo "It stopped (exit code $status). The end of its output:" >&2
    tail -n 12 "$err" >&2
  fi
  rm -f "$err"
  exit "$status"
}

# Starts Electron in the background, as the .bat files do on Windows; its output goes to a log file
# that only this user can read. launch <log name> <electron arguments...>
launch() {
  local log="${XDG_RUNTIME_DIR:-${TMPDIR:-/tmp}}/$1.log"
  shift
  # Added to, not started anew: a second start (which only reaches the running program and ends) would
  # otherwise empty the log the running one still writes to.
  (umask 077; echo "---- $(date '+%F %T') started" >>"$log"; exec setsid "$electron" "${sandbox_args[@]}" "$@" >>"$log" 2>&1 </dev/null) &
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
