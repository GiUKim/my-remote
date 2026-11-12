#!/usr/bin/env bash
# My Remote client app on Linux (X11 session). Run ./setup.sh --skip-selftest once first
# (it installs Electron under host/node_modules).
set -euo pipefail
. "$(dirname "$0")/host/linux-launch.sh"
need_electron
check_session
check_sandbox
launch my-remote-client "$root/client" "$@"
