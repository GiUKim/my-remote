#!/usr/bin/env bash
# Try it on this PC only: host + view-only client in your browser.
# Uses a local relay and a throwaway key. Nothing is sent to the internet.
set -euo pipefail
. "$(dirname "$0")/host/linux-launch.sh"
need_electron
check_session
check_sandbox
launch my-remote-localtest "$root/host" --localtest "$@"
