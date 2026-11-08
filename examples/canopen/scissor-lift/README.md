# Scissor lift: a CANopen example

A mobile elevating work platform with four devices on one CAN bus. Each device is its own OpenPLC
project. It runs on one Linux host without any CAN hardware: four runtime containers share a
virtual CAN bus, and a machine panel in your browser plays the operator, the safety relay, the
hydraulics and the sensors.

**This is a demonstration. It is not a safety system.** The emergency stop goes through a simulated
safety relay that cuts the valve power. The PLCs only read its status, because the machine has no safety PLC.

![The scissor lift and its devices](images/machine.svg)

## Devices

| Project | Role | Node | What it shows |
|---|---|---|---|
| `chassis-controller` | CANopen master | 1 | PDOs, SYNC, heartbeat, master watch, startup SDOs, LSS assignment, node control, SDO and EMCY blocks, interlocks |
| `platform-box` | CANopen slave | 10 | LSS "wait for master" with a random serial, event-timed TPDO, packed bit objects, local I/O blocks |
| `valve-module` | CANopen slave | 20 | RPDO receive timeout, parameter object written over SDO, program EMCY on a coil fault, slave status and written-object blocks |
| `tilt-sensor` | CANopen slave | 30 | SYNC-driven TPDO, parameters, a read-only serial and operating time, program EMCY on overload |
| (none) | optional work light | 40 | an optional node the master may find or not (device file only) |

`device-files/` holds the EDS file of each device, exported from its slave page. The master project
imports them, so the master sees the slaves the way a real master would.

![The machine bus](images/bus.svg)

Behaviour you can try:

- The stick and the enable switch drive the lift and the chassis through the valve module.
- A tilt above 3.00 degrees with the platform raised stops the valve module over NMT. It restarts
  below 2.50 degrees with the stick in neutral.
- A load above the limit (450 kg) raises an emergency message and a lamp.
- Either emergency stop opens the safety relay, which cuts the valve power. The valve module sees the
  relay's status contact; the platform box sees its own button contact. Neither decides anything.
- Stop a slave and watch the master hold its inputs, stop its outputs and keep scanning.
- Replace the platform box: the new box has a new random serial and no node ID, and the master
  commissions it again over LSS.

## What you need

- A Linux host: a Raspberry Pi 4 or 5, or a PC (also a Linux virtual machine). Run the commands as root.
- Docker Engine.
- `iproute2`, `util-linux` (`nsenter`), `can-utils` (`cangw`) and `python3`.
- The kernel modules `vxcan`, `can-gw` and `gpio-sim`. Most distribution kernels have them.
- The OpenPLC Editor with CANopen support (this fork) on the same machine or another one: a release
  newer than `v4.3.3-canopen.2`, or a build of this branch. `v4.3.3-canopen.2` and older cannot compile
  the slave projects ("Nothing produces %IW on this target").

![The host](images/host.svg)

## Run it

```bash
sudo ./run.sh up        # four runtime containers, the bus, the gateway and the GPIO chips
sudo ./run.sh status    # what each runtime reports
sudo ./run.sh panel     # the machine panel at http://127.0.0.1:8080
sudo ./run.sh down      # remove everything the example made
```

The runtimes are at `127.0.0.10` (chassis controller), `127.0.0.11` (platform box), `127.0.0.12`
(valve module) and `127.0.0.13` (tilt sensor), port 8443. They also listen on `127.0.0.1:18443` to
`18446`. When another runtime on the host already uses port 8443, `run.sh up` says so and publishes only
the `18443` to `18446` ports; reach the runtimes from another machine with the helpers below. Each runtime needs a user once; the example uses `lift` with the password `lift-example`
(set `SCISSOR_USER` and `SCISSOR_PASSWORD` to change them). The image is
`ghcr.io/tonihoohoo/openplc-runtime:v4.3.2-canopen.3`; set `SCISSOR_IMAGE` for another.

### Open the editor

- **Linux, the editor on the host:** use the addresses above.
- **Mac:** `./mac-connect.sh user@host` adds loopback addresses and one SSH session that forwards them to
  the runtimes' ports `18443` to `18446` and the panel. `./mac-connect.sh --remove` takes them away.
- **Windows, the example on a Linux host or virtual machine:** `.\connect.ps1 user@host` opens one SSH session that
  forwards the four addresses to the runtimes' ports `18443` to `18446` and the panel to
  `http://127.0.0.1:8080`. It uses the OpenSSH client that comes with Windows.

Open the four folders as projects in the editor and upload each to its address. The chassis
controller goes to `127.0.0.10`. Upload the three slaves first, then the master.

### Commission the platform box

The platform box starts without a node ID and a random serial number. The chassis controller's platform
node is given its node ID over LSS, but the project does not know the box's serial yet. Open the master's
Online tab and run the LSS search: it lists the box with its serial number. Enter that serial in the LSS
settings of the platform node and upload the chassis controller again; from then on the master gives the
box node 10 at every start. To start at once, "Give node ID" in the search result gives it node 10 now. `./run.sh swap` replaces the box
with a new one, so you can see a spare part being commissioned.

## The machine panel

`./run.sh panel` serves a page with the lift drawing, the stick, the switches, the two emergency
stops with the safety relay reset, a slope and a load slider, a coil-fault switch, the scenario buttons
and a table of what each runtime reports. The panel binds to `127.0.0.1`; use `--bind` only on a
network you trust, because it has no login.

The panel sets the digital inputs through simulated GPIO chips that the `linux_io` blocks read, and
sends the analog values as frames on a per-device simulation bus where a "Terminals (simulation)"
slave turns them into process data. Nothing about the machine logic is in the panel except the
physics: the PLC programs only see inputs.

## Checked with

The projects compile and the master configuration validates with the editor's own checks. The example
ran on a Raspberry Pi 5 (64-bit Raspberry Pi OS) with the projects uploaded from the editor on
Windows over an SSH tunnel: lift, lower and drive, both emergency stops and the relay reset, the tilt alarm
with its restart, overload, the coil fault, stopping and starting a device, and replacing the platform box.

## Files

| Path | What it is |
|---|---|
| `chassis-controller/`, `platform-box/`, `valve-module/`, `tilt-sensor/` | the four OpenPLC projects |
| `device-files/` | EDS files exported from the slaves |
| `run.sh` | create, inspect and remove the example |
| `panel/` | the machine panel (Python standard library and one HTML page) |
| `connect.ps1`, `mac-connect.sh` | helpers to reach the runtimes from Windows and Mac |
| `images/` | the drawings above |
