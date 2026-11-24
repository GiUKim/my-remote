#!/usr/bin/env bash
# Pangmote, the installed app on Linux (X11 session). The app menu entry runs this with --client --launcher;
# --host and --client start a face, without either the app asks. Other arguments go to the app (--selftest,
# --show-key). The checks (X11 session, the desktop's libraries, Chromium's sandbox) and the start in the
# background are the launchers' of the source folder (host/linux-launch.sh of the code this package came with).
# (Up to 0.9.x the program was called My Remote and this script my-remote.sh: see host/shellswap.js.)
set -euo pipefail
here="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
export PANGMOTE_ELECTRON="$here/pangmote"
. "$here/resources/app/bundle/host/linux-launch.sh"
mr_app=() # the program is the app itself: no folder to name
[ "${1:-}" = "--show-key" ] && show_key
check_libs
check_session
check_sandbox
case " $* " in
  *" --client "*) launch pangmote-client "$@" ;;
  *" --host "*) launch pangmote-host "$@" ;;
  *) exec "$electron" "${sandbox_args[@]}" "$@" ;; # asks which, or runs a test in this terminal
esac
