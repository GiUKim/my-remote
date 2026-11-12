#!/usr/bin/env bash
# My Remote host on Linux (X11 session). Run ./setup.sh once first.
# Connects this PC to the signaling server and makes it reachable with its access key.
set -euo pipefail
. "$(dirname "$0")/host/linux-launch.sh"
need_electron
check_session
check_sandbox
launch my-remote-host "$root/host" "$@"
