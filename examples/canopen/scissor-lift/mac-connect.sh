#!/usr/bin/env bash
# Makes the four runtimes of the scissor lift example, running on another Linux host (for example
# a Raspberry Pi), reachable from the editor on this Mac at 127.0.0.10 - 127.0.0.13, port 8443, and
# the machine panel at http://127.0.0.1:8080, over one SSH connection. Needs sudo once to add the
# loopback addresses. Keep it running; Ctrl+C closes the connection.
#   ./mac-connect.sh user@host
#   ./mac-connect.sh --remove      removes the loopback addresses again
set -euo pipefail

addresses=(127.0.0.10 127.0.0.11 127.0.0.12 127.0.0.13)

if [ "${1:-}" = "--remove" ]; then
    for a in "${addresses[@]}"; do sudo ifconfig lo0 -alias "$a" 2>/dev/null || true; done
    echo "Removed the loopback addresses."
    exit 0
fi
[ $# -eq 1 ] || { echo "usage: $0 user@host | --remove" >&2; exit 2; }

forwards=(-L 8080:127.0.0.1:8080)
for a in "${addresses[@]}"; do
    ifconfig lo0 | grep -q "inet $a " || sudo ifconfig lo0 alias "$a" up
    forwards+=(-L "$a:8443:$a:8443")
done
echo "Editor: 127.0.0.10 chassis-controller, .11 platform-box, .12 valve-module, .13 tilt-sensor. Panel: http://127.0.0.1:8080"
exec ssh -N "${forwards[@]}" "$1"
