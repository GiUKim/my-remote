#!/usr/bin/env bash
# Try it on this PC only: host + view-only client (the client app). The first start sets this folder up.
# Uses a local relay and a throwaway key. Nothing is sent to the internet.
set -euo pipefail
. "$(dirname "$0")/host/linux-launch.sh"
ensure_setup
check_session
check_sandbox
launch pangmote-localtest "$root/host" --localtest "$@"
