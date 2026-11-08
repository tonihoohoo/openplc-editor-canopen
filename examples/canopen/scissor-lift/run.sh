#!/usr/bin/env bash
# Runs the scissor lift example on one Linux host:
# four OpenPLC runtimes in containers on one virtual CAN bus, simulated GPIO chips for the
# digital terminals and the machine panel. Run as root. See README.md.
#
#   run.sh up              start the containers, the bus and the GPIO chips
#   run.sh down            remove everything `up` created
#   run.sh status          show each runtime's CANopen status in short form
#   run.sh stop <device>   stop a device's container (chassis, platform, valves or sensor)
#   run.sh start <device>  start it again and join it to the bus
#   run.sh swap            replace the platform box by a new one with a new serial number
#   run.sh panel [--bind ADDRESS] [--port PORT]   open the machine panel (default 127.0.0.1:8080)
set -Eeuo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGE="${SCISSOR_IMAGE:-ghcr.io/tonihoohoo/openplc-runtime:v4.3.2-canopen.4}"
STATE_DIR="${SCISSOR_STATE_DIR:-/run/scissor-lift}"
USER_NAME="${SCISSOR_USER:-lift}"
USER_PASSWORD="${SCISSOR_PASSWORD:-lift-example}"

DEVICES=(chassis platform valves sensor)
# Host ports of the runtimes' API, in the order of DEVICES, and the loopback address each also gets.
declare -A API_PORT=([chassis]=18443 [platform]=18444 [valves]=18445 [sensor]=18446)
declare -A LOOP_ADDR=([chassis]=127.0.0.10 [platform]=127.0.0.11 [valves]=127.0.0.12 [sensor]=127.0.0.13)
# Host end of each device's machine bus link and of its simulation bus link (names stay under 15 characters).
declare -A BUS_LINK=([chassis]=vxlift-ch [platform]=vxlift-pb [valves]=vxlift-vm [sensor]=vxlift-sn)
declare -A SIM_LINK=([platform]=vxsim-pb [valves]=vxsim-vm [sensor]=vxsim-sn)
# Simulated GPIO chips, and their lines in offset order.
declare -A CHIP_LINES=(
    [platform]="PB_ESTOP_NC PB_ENABLE PB_DRIVE_MODE PB_HORN PB_LIGHT PB_LAMP_READY PB_LAMP_ESTOP PB_LAMP_TILT PB_LAMP_LOAD PB_BUZZER PB_LAMP_FAULT"
    [valves]="VM_SUPPLY_OK VM_COIL_FAULT VM_LIFT_UP VM_LIFT_DOWN VM_DRIVE_FWD VM_DRIVE_REV"
)
CONFIGFS=/sys/kernel/config

die() { echo "run.sh: $*" >&2; exit 1; }
need_root() { [ "$(id -u)" -eq 0 ] || die "run as root (sudo ./run.sh $*)"; }
valid_device() {
    local d
    for d in "${DEVICES[@]}"; do [ "$d" = "$1" ] && return 0; done
    die "unknown device '$1'; use one of: ${DEVICES[*]}"
}
container() { echo "scissor-$1"; }
volume() { echo "scissor-$1-data"; }

check_host() {
    local cmd missing=()
    for cmd in docker ip nsenter cangw python3; do
        command -v "$cmd" >/dev/null 2>&1 || missing+=("$cmd")
    done
    if [ "${#missing[@]}" -gt 0 ]; then
        die "missing commands: ${missing[*]} (docker, iproute2, util-linux, can-utils and python3 are needed)"
    fi
    local mod
    for mod in vxcan can-gw gpio-sim; do
        if ! modprobe "$mod" 2>/dev/null; then
            die "the kernel module $mod is missing: install the kernel's extra modules"
        fi
    done
    mountpoint -q "$CONFIGFS" || mount -t configfs none "$CONFIGFS" 2>/dev/null || true
    [ -d "$CONFIGFS/gpio-sim" ] || die "configfs has no gpio-sim directory (is $CONFIGFS mounted?)"
}

# ---------------------------------------------------------------- GPIO chips
make_chip() {
    local dev="$1" chip="$CONFIGFS/gpio-sim/scissor-$1" lines i=0 name
    read -r -a lines <<<"${CHIP_LINES[$dev]}"
    mkdir -p "$chip/gpio-bank0"
    echo "${#lines[@]}" >"$chip/gpio-bank0/num_lines"
    for name in "${lines[@]}"; do
        mkdir -p "$chip/gpio-bank0/line$i"
        echo "$name" >"$chip/gpio-bank0/line$i/name"
        i=$((i + 1))
    done
    echo 1 >"$chip/live"
}

remove_chip() {
    local chip="$CONFIGFS/gpio-sim/scissor-$1" line
    [ -d "$chip" ] || return 0
    echo 0 >"$chip/live" 2>/dev/null || true
    for line in "$chip"/gpio-bank0/line*; do
        [ -d "$line" ] || continue
        rmdir "$line/hog" 2>/dev/null || true
        rmdir "$line" 2>/dev/null || true
    done
    rmdir "$chip/gpio-bank0" 2>/dev/null || true
    rmdir "$chip" 2>/dev/null || true
}

chip_device() { # the /dev node and sysfs directory of a device's chip
    local chip="$CONFIGFS/gpio-sim/scissor-$1" dev name
    dev="$(cat "$chip/dev_name")"
    name="$(cat "$chip/gpio-bank0/chip_name")"
    echo "/dev/$name /sys/devices/platform/$dev/$name"
}

# ---------------------------------------------------------------- containers and links
# False when something (another runtime on the host, for example) already listens on port 8443
# on all addresses or on this one.
loop_port_free() {
    ! ss -Hltn 2>/dev/null | awk '{print $4}' | grep -qE "^(0\.0\.0\.0|\*|\[::\]|$1):8443$"
}

run_container() {
    local dev="$1" args=() chipdev
    args+=(--name "$(container "$dev")" -d
        --cap-add SYS_NICE --cap-add SYS_RESOURCE --ulimit rtprio=99 --ulimit memlock=-1
        -v "$(volume "$dev"):/var/run/runtime"
        -p "127.0.0.1:${API_PORT[$dev]}:8443")
    if loop_port_free "${LOOP_ADDR[$dev]}"; then
        args+=(-p "${LOOP_ADDR[$dev]}:8443:8443")
    else
        echo "run.sh: port 8443 is in use on this host, so $(container "$dev") is only at 127.0.0.1:${API_PORT[$dev]}" >&2
    fi
    if [ -n "${CHIP_LINES[$dev]:-}" ]; then
        read -r chipdev _ <<<"$(chip_device "$dev")"
        args+=(--device "$chipdev")
    fi
    docker run "${args[@]}" "$IMAGE" >/dev/null
}

container_pid() {
    local pid
    pid="$(docker inspect -f '{{.State.Pid}}' "$(container "$1")" 2>/dev/null || echo 0)"
    [ "$pid" -gt 0 ] || die "$(container "$1") is not running"
    echo "$pid"
}

# Moves a fresh vxcan pair into a container: the container end is $2, the host end $3.
attach_link() {
    local dev="$1" inside="$2" host="$3" pid
    pid="$(container_pid "$dev")"
    ip link del "$host" 2>/dev/null || true
    ip link add "$host" type vxcan peer name "$inside" netns "$pid"
    ip link set "$host" up
    nsenter -t "$pid" -n ip link set "$inside" up
}

attach_device() {
    local dev="$1"
    attach_link "$dev" can0 "${BUS_LINK[$dev]}"
    if [ -n "${SIM_LINK[$dev]:-}" ]; then attach_link "$dev" sim0 "${SIM_LINK[$dev]}"; fi
}

# Every machine bus link forwards to every other one; a frame is forwarded once. Only these rules
# are added and removed; other gateway rules on the host are left alone. The kernel drops a rule
# by itself when one of its links goes away, so a device that comes back only needs its own rules
# added, and the rest of the bus keeps running meanwhile.
#   gateway_rules A|D [device]   add or delete the rules of every link, or only those of one device
gateway_rules() {
    local action="$1" only="${2:-}" a b
    for a in "${DEVICES[@]}"; do
        ip link show "${BUS_LINK[$a]}" >/dev/null 2>&1 || continue
        for b in "${DEVICES[@]}"; do
            [ "$a" = "$b" ] && continue
            [ -z "$only" ] || [ "$a" = "$only" ] || [ "$b" = "$only" ] || continue
            ip link show "${BUS_LINK[$b]}" >/dev/null 2>&1 || continue
            if [ "$action" = D ]; then
                # Removes every copy of the rule, a few at most.
                for _ in 1 2 3 4 5 6 7 8; do
                    cangw -D -s "${BUS_LINK[$a]}" -d "${BUS_LINK[$b]}" 2>/dev/null || break
                done
            else
                cangw -A -s "${BUS_LINK[$a]}" -d "${BUS_LINK[$b]}" 2>/dev/null || true
            fi
        done
    done
}

write_state() {
    mkdir -p "$STATE_DIR"
    local dev first=1 chipdev sysfs
    {
        echo '{"user": "'"$USER_NAME"'", "password": "'"$USER_PASSWORD"'", "devices": {'
        for dev in "${DEVICES[@]}"; do
            [ "$first" -eq 1 ] || echo ','
            first=0
            printf '"%s": {"port": %s, "bus": "%s"' "$dev" "${API_PORT[$dev]}" "${BUS_LINK[$dev]}"
            if [ -n "${SIM_LINK[$dev]:-}" ]; then printf ', "sim": "%s"' "${SIM_LINK[$dev]}"; fi
            if [ -n "${CHIP_LINES[$dev]:-}" ]; then
                read -r chipdev sysfs <<<"$(chip_device "$dev")"
                printf ', "chip": "%s", "sysfs": "%s", "lines": "%s"' "$chipdev" "$sysfs" "${CHIP_LINES[$dev]}"
            fi
            printf '}'
        done
        echo '}}'
    } >"$STATE_DIR/state.json"
}

# ---------------------------------------------------------------- commands
cmd_up() {
    need_root up
    check_host
    local dev
    for dev in "${DEVICES[@]}"; do
        if docker inspect "$(container "$dev")" >/dev/null 2>&1; then die "$(container "$dev") exists; run 'run.sh down' first"; fi
    done
    trap 'echo "run.sh: up failed, removing what it made" >&2; cmd_down >/dev/null' ERR
    for dev in "${!CHIP_LINES[@]}"; do make_chip "$dev"; done
    for dev in "${DEVICES[@]}"; do run_container "$dev"; done
    for dev in "${DEVICES[@]}"; do attach_device "$dev"; done
    gateway_rules A
    write_state
    trap - ERR
    cat <<EOF
The four runtimes are up. Open them from the editor at:
  chassis-controller  127.0.0.10   platform-box  127.0.0.11   valve-module  127.0.0.12   tilt-sensor  127.0.0.13
Create the user '$USER_NAME' with the password '$USER_PASSWORD' on each, upload the four projects,
then open the machine panel with: sudo ./run.sh panel
EOF
}

cmd_down() {
    need_root down
    local dev
    gateway_rules D
    for dev in "${DEVICES[@]}"; do
        docker rm -f "$(container "$dev")" >/dev/null 2>&1 || true
        docker volume rm "$(volume "$dev")" >/dev/null 2>&1 || true
        ip link del "${BUS_LINK[$dev]}" 2>/dev/null || true
        if [ -n "${SIM_LINK[$dev]:-}" ]; then ip link del "${SIM_LINK[$dev]}" 2>/dev/null || true; fi
    done
    for dev in "${!CHIP_LINES[@]}"; do remove_chip "$dev"; done
    rm -rf "$STATE_DIR"
    echo "Removed the containers, volumes, links, gateway rules and GPIO chips."
}

cmd_stop() {
    need_root stop
    valid_device "$1"
    docker stop "$(container "$1")" >/dev/null
    gateway_rules D "$1"
    echo "$1 stopped."
}

cmd_start() {
    need_root start
    valid_device "$1"
    docker start "$(container "$1")" >/dev/null
    attach_device "$1"
    gateway_rules A "$1"
    echo "$1 started."
}

cmd_swap() {
    need_root swap
    docker rm -f "$(container platform)" >/dev/null 2>&1 || true
    docker volume rm "$(volume platform)" >/dev/null 2>&1 || true
    run_container platform
    attach_device platform
    gateway_rules A platform
    echo "A new platform control box is on the bus without a node ID. Upload platform-box to 127.0.0.11"
    echo "again, then find it with the Online tab's search for devices without a node ID."
}

cmd_status() {
    command -v python3 >/dev/null 2>&1 || die "python3 is needed"
    [ -r "$STATE_DIR/state.json" ] || die "the example is not up (run 'sudo ./run.sh up')"
    python3 "$HERE/panel/server.py" --state "$STATE_DIR/state.json" --status
}

cmd_panel() {
    need_root panel
    [ -r "$STATE_DIR/state.json" ] || die "the example is not up (run 'sudo ./run.sh up')"
    exec python3 "$HERE/panel/server.py" --state "$STATE_DIR/state.json" --run "$HERE/run.sh" "$@"
}

case "${1:-}" in
    up) cmd_up ;;
    down) cmd_down ;;
    status) cmd_status ;;
    stop) [ $# -eq 2 ] || die "usage: run.sh stop <device>"; cmd_stop "$2" ;;
    start) [ $# -eq 2 ] || die "usage: run.sh start <device>"; cmd_start "$2" ;;
    swap) cmd_swap ;;
    panel) shift; cmd_panel "$@" ;;
    *) sed -n '2,13p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; [ -z "${1:-}" ] || exit 2 ;;
esac
