# Open PLC Editor - IDE

> **CANopen edition.** This is an unofficial fork of the OpenPLC Editor that adds a CANopen device type.
> It is not made or supported by the upstream OpenPLC project.
>
> In a project you add a CANopen network and its nodes, import each node's EDS, map its PDO entries
> to PLC variables, set start-up SDOs and node options, and watch the nodes' status online. The
> project runs on the [OpenPLC Runtime (CANopen edition)](https://github.com/tonihoohoo/openplc-runtime-canopen),
> and the editor refuses to upload a CANopen project to a runtime without CANopen support. Everything
> else works as in upstream OpenPLC Editor.
>
> Installing it replaces an installed OpenPLC Editor, and it offers updates from this fork's
> [releases](https://github.com/tonihoohoo/openplc-editor-canopen/releases) only. More:
> [docs/canopen.md](docs/canopen.md).

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
