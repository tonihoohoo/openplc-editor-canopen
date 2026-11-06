# Open PLC Editor - IDE

> **CANopen edition.** This is an unofficial fork of the OpenPLC Editor that adds a CANopen device type.
> It is not made or supported by the upstream OpenPLC project.
>
> In a project you add a CANopen network and its nodes, import each node's EDS, map its PDO entries
> to PLC variables, set start-up SDOs and node options, and watch the nodes' status online. A CANopen
> slave server makes the runtime a CANopen device for another master. The
> project runs on the [OpenPLC Runtime (CANopen edition)](https://github.com/tonihoohoo/openplc-runtime-canopen),
> and the editor refuses to upload a CANopen project to a runtime without CANopen support. The fork
> also adds a few editor improvements; every difference from upstream is listed below.
>
> Installing it replaces an installed OpenPLC Editor, and it offers updates from this fork's
> [releases](https://github.com/tonihoohoo/openplc-editor-canopen/releases) only. More:
> [docs/canopen.md](docs/canopen.md).

## Changes from upstream OpenPLC Editor

Everything not listed here works as in upstream OpenPLC Editor.

CANopen:

- CANopen network and nodes as a remote device, with PDO entries mapped to PLC variables: [docs/canopen.md](docs/canopen.md#using-it)
- Nodes from EDS, DCF, XDD and XDC files with a CiA 306 / CiA 311 check, and export to EDS, DCF, XDD, XDC, DBC and HTML: [docs/canopen.md](docs/canopen.md#device-files)
- Node startup and supervision options, startup SDOs and their refusal policies: [docs/canopen.md](docs/canopen.md#startup-and-supervision-options)
- Node IDs given by the master over LSS (CiA 305) at every start: [docs/canopen.md](docs/canopen.md#node-id-over-lss)
- Find devices without a node ID over LSS, give one an ID or set its bit rate: [docs/canopen.md](docs/canopen.md#devices-without-node-id-lss)
- Live status of the bus and the nodes while connected: [docs/canopen.md](docs/canopen.md#live-status)
- Online SDO and NMT tools and service mode: [docs/canopen.md](docs/canopen.md#online-tools)
- The `canopen` function block library (CiA 405 names) for SDO, NMT and node control from the PLC program: [docs/canopen.md](docs/canopen.md#plc-function-blocks)
- Slave blocks for the PLC program: the slave's state, its own NMT state, the program's emergencies and the master's writes, and the slave's NMT state on a PLC stop: [docs/canopen.md](docs/canopen.md#plc-function-blocks)
- CANopen addresses from the central registry, up to the runtime's limit of 65536 per table: [docs/canopen.md](docs/canopen.md#addresses)
- CANopen slave server: the runtime as a CANopen device with objects, PDOs, an EDS or XDD export and a Status tab that shows the running slave and what its master changed: [docs/canopen.md](docs/canopen.md#canopen-slave)
- LSS (CiA 305) in the CANopen slave: an LSS master gives it its node ID and bit rate: [docs/canopen.md](docs/canopen.md#lss)
- Up to 16 RPDOs and 16 TPDOs in the CANopen slave, each object placed in the PDO you choose, COB-IDs of PDO 5-16 given by the master or fixed, and an RPDO receive timeout: [docs/canopen.md](docs/canopen.md#canopen-slave)
- CANopen slave objects packed as 8 bits: one UNSIGNED8 on the bus, eight named BOOL addresses in the program: [docs/canopen.md](docs/canopen.md#objects-packed-as-8-bits)
- XDD details of the CANopen slave behind the Expert view: descriptions, units and scales, value meanings, groups, product text, characteristics and the hardware version 0x1009: [docs/canopen.md](docs/canopen.md#xdd-details-of-the-slave)
- CANopen slave in the firmware of an ESP32 board, on its own CAN controller with two GPIO pins: [docs/canopen.md](docs/canopen.md#slave-on-an-esp32-board)
- Upload refused to a runtime without CANopen support: [docs/canopen.md](docs/canopen.md#installing-a-release-and-the-runtime-check)

Editor:

- Function block calls from the variable table: drag a row by its `#` cell into the ST body, or "Insert call" in the variables code view: [docs/st-calls.md](docs/st-calls.md#inserting-a-call-for-an-instance)
- Call completion in ST for instances and functions, also single parameters added later: [docs/st-calls.md](docs/st-calls.md#call-completion)
- "Remove empty parameters" quick fix for calls: [docs/st-calls.md](docs/st-calls.md#remove-empty-parameters)
- A function block dragged from the library into ST gets its outputs too: [docs/st-calls.md](docs/st-calls.md#library-drop)
- Documentation in ST hovers and in the suggestion details: [docs/st-calls.md](docs/st-calls.md#documentation-in-st)
- Language server suggestions show their own icons (upstream showed most with the wrong icon): [docs/st-calls.md](docs/st-calls.md#suggestion-icons)

Releases:

- Releases, the update notice and the runtime's Change version dialog use this fork's releases: [docs/canopen-releases.md](docs/canopen-releases.md)

## Running a preview version

In order to run the development version, clone the repository, and install dependencies via `npm`, you need network access.

You'll need the following tools:

- [Git](https://git-scm.com/)
- [NodeJS](https://nodejs.org/en/download/), version `>=22 <24`

### Step by step

- Clone the repository locally and go to the project folder.

```bash
git clone https://github.com/tonihoohoo/openplc-editor-canopen.git

cd openplc-editor-canopen
git checkout canopen
```

- Install the dependencies

```bash
npm install
```

- Run the development script

```bash
npm run dev
```

### Running tests

```bash
npm run test         # Unit tests (Jest, with coverage)
npm run test:watch   # Unit tests in watch mode (no coverage)
npm run test:e2e     # End-to-end tests (Playwright, builds the app first)
```

## Releasing a New Version

Releases of this fork are tagged `v<upstream version>-canopen.<N>` and published by the **CANopen
release** workflow, see [docs/canopen-releases.md](docs/canopen-releases.md). Upstream's tag-driven
release flow is not used here.

## Documentation

The CANopen device type is described in [docs/canopen.md](docs/canopen.md). For everything else, see
the upstream [wiki](https://github.com/Autonomy-Logic/openplc-editor/wiki).

## Issues

Report problems with this fork on its [issues](https://github.com/tonihoohoo/openplc-editor-canopen/issues) page.

## License

The OpenPLC Editor is licensed under the GPLv3 (see [LICENSE](LICENSE)).

The baremetal runtime the editor builds into microcontroller firmware is dual-licensed: GPLv3 or a commercial licence. If you are using it in a commercial setting, you may need a commercial licence. Licences can be bought from the OpenPLC Editor (desktop or web) when you upload a program to the device.

The Contributor License Agreement in [CLA.md](CLA.md) applies to the upstream repository; this fork does not ask for one.

## Trademarks

OpenPLC Editor is developed and maintained by Autonomy Logic. The CANopen edition is an independent fork
and is not affiliated with or endorsed by Autonomy Logic. CANopen is a registered trademark of CAN in
Automation e.V.
