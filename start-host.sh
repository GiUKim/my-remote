#!/usr/bin/env bash
# My Remote host on Linux (X11 session). The first start sets this folder up by itself (setup.sh).
# Connects this PC to the signaling server and makes it reachable with its access key.
set -euo pipefail
. "$(dirname "$0")/host/linux-launch.sh"
ensure_setup
check_session
check_sandbox
launch my-remote-host "$root/host" "$@"
