#!/usr/bin/env bash
# My Remote client app on Linux (X11 session). The first start sets this folder up by itself
# (setup.sh without the self-test: it installs Electron under host/node_modules).
set -euo pipefail
. "$(dirname "$0")/host/linux-launch.sh"
ensure_setup
check_session
check_sandbox
launch my-remote-client "$root/client" "$@"
