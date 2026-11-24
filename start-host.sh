#!/usr/bin/env bash
# Pangmote host on Linux (X11 session). The first start sets this folder up by itself (setup.sh).
# Connects this PC to the signaling server and makes it reachable with its access key.
set -euo pipefail
. "$(dirname "$0")/host/linux-launch.sh"
[ "${1:-}" = "--show-key" ] && show_key # prints the access key here and ends (for a PC reached over ssh)
ensure_setup
check_session
check_sandbox
launch pangmote-host "$root/host" "$@"
