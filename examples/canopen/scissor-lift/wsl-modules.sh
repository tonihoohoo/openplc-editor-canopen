#!/usr/bin/env bash
# Builds and loads the two kernel modules the stock WSL 2 kernel lacks, vxcan (CAN link pairs) and
# gpio-sim (simulated GPIO chips), for the running WSL kernel. Run as root inside the WSL
# distribution, again after every WSL kernel update and after `wsl --shutdown`. Needs about 1 GB of
# disk for the kernel source while it builds, and the build tools:
#   apt install build-essential bc flex bison libssl-dev libelf-dev curl kmod
set -euo pipefail

die() { echo "wsl-modules.sh: $*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run as root (sudo ./wsl-modules.sh)"
grep -qi microsoft /proc/sys/kernel/osrelease || die "this is for WSL 2 only; on other Linux hosts install the kernel's extra modules"

release="$(uname -r)"
tag="linux-msft-wsl-${release%%-*}"
extra="/lib/modules/$release/extra"

load_all() {
    modprobe can-dev
    modprobe can-gw
    # The modules are built from the kernel's own source and configuration, so their symbol checksums
    # are not checked (-f): the running kernel has no Module.symvers to compare with.
    lsmod | grep -q '^vxcan ' || insmod -f "$extra/vxcan.ko"
    lsmod | grep -q '^gpio_sim ' || insmod -f "$extra/gpio-sim.ko"
    echo "vxcan and gpio-sim are loaded."
}

if [ -f "$extra/vxcan.ko" ] && [ -f "$extra/gpio-sim.ko" ]; then
    load_all
    exit 0
fi

for tool in make gcc bc flex bison curl tar; do
    command -v "$tool" >/dev/null 2>&1 || die "$tool is missing; install: apt install build-essential bc flex bison libssl-dev libelf-dev curl kmod"
done

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
echo "Downloading the kernel source $tag ..."
curl -fsSL "https://github.com/microsoft/WSL2-Linux-Kernel/archive/refs/tags/$tag.tar.gz" | tar -xz -C "$work" --strip-components=1
cd "$work"

if [ -r /proc/config.gz ]; then
    zcat /proc/config.gz >.config
else
    curl -fsSL "https://raw.githubusercontent.com/microsoft/WSL2-Linux-Kernel/$tag/arch/x86/configs/config-wsl" >.config
fi
scripts/config --module CAN_VXCAN --module GPIO_SIM --disable DEBUG_INFO_BTF --disable DEBUG_INFO_BTF_MODULES
make olddefconfig >/dev/null
make -j"$(nproc)" modules_prepare >/dev/null
make -j"$(nproc)" M=drivers/net/can CONFIG_CAN_VXCAN=m modules >/dev/null
make -j"$(nproc)" M=drivers/gpio CONFIG_GPIO_SIM=m modules >/dev/null

mkdir -p "$extra"
cp drivers/net/can/vxcan.ko drivers/gpio/gpio-sim.ko "$extra/"
depmod -a
load_all
