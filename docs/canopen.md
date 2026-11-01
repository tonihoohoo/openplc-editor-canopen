# CANopen — OpenPLC Editor

A CANopen network is a remote device with protocol `canopen`. The editor builds each node from its
EDS file, maps its PDOs to IEC locations, and writes everything the runtime's `canopen` plugin
needs into `conf/canopen.json`. The runtime never reads an EDS; its side, and the file format, are
described in the runtime's `docs/CANOPEN.md`.

```
EDS or DCF file → checkEds (CiA 306) → parseEds → createCanopenNode → project (remote device JSON)
                                               ↓
               build: validateCanopenProject → generateCanopenConfig → conf/canopen.json
```

CANopen is offered where EtherCAT is: on targets whose capabilities set `ethercat` (Runtime v4).

## Using it

1. Add a remote device and pick **CANopen**. One device is one CAN interface.
2. **Network** tab: the SocketCAN interface on the runtime device (`can0`), the bit rate (or
   "Leave as configured" for a link set up outside the runtime), the master node ID, the master's
   heartbeat (100 ms for a new network), the real-time priority of the bus work on the runtime
   (1 to 97, default 90, above the PLC tasks), SYNC (none, once per PLC cycle, or a fixed period)
   and the NMT state the nodes get when the PLC stops. Further groups set the startup and error
   behaviour, TIME and the defaults for new nodes (see "Startup and supervision options").
3. **Nodes** tab: **Add node from EDS or DCF...** reads the file, picks the lowest free node ID and
   maps the PDOs the EDS defines by default. Set the node ID to the one set on the device. The file
   is checked first (see "EDS and DCF files"), and a dialog shows the result before the node is added.
4. For each node:
   - **General**: name, node ID, **Optional node**, which identity values the master checks at boot
     (vendor ID and product code by default; the revision is off so newer firmware still boots),
     supervision (heartbeat with the node's producer time and the master's timeout, or node guarding
     with guard time and life time factor), what the node's inputs do
     when it is lost, and the `%IB` that reads its NMT state. **Watch the master** is on for a node
     whose EDS has a writable 0x1016: the node then reacts when the master's heartbeat stops, for
     example when the runtime dies, by going pre-operational (or stopped, or nothing, through
     0x1029:1 when the EDS has it). The master writes these after the startup SDOs. It needs a
     master heartbeat shorter than the node's timeout.
   - **Inputs** / **Outputs**: the node's transmit PDOs (PLC inputs, `%I`) and receive PDOs (PLC
     outputs, `%Q`). A PDO can be switched off, its COB-ID, transmission type, event timer and
     inhibit time changed, and its entries added, removed and reordered (drag handle or the up and
     down buttons; the order is the layout of the frame). **Add object** opens a list of the objects
     the EDS marks as mappable, searchable by index (`6401`, `0x6401:01`) or name; an entry that
     would take the PDO over 64 bits is listed but disabled. A mapping the EDS marks read-only is
     fixed.
   - The transmission type is one of synchronous acyclic (0), synchronous every N SYNC (1-240),
     event-driven manufacturer specific (254) or event-driven device profile (255); choices outside
     the EDS's `LowLimit`/`HighLimit` are disabled and the EDS default is marked. Remote request
     (RTR) types 252 and 253 are not supported: an EDS default of 252 or 253 becomes 255, and the
     build refuses them. A synchronous type on a network without SYNC shows a warning.
   - An enabled TPDO has a **Receive timeout** (off at 0): the master's RPDO event timer
     (`0x14xx:05`). When the PDO does not arrive in that time the master reports it late, logs it and
     treats the inputs as it does for a lost node. A timeout shorter than the event timer, or shorter
     than two SYNC intervals of a synchronous PDO on a fixed SYNC period, shows a warning. So does a
     timeout on a PDO the node sends only after a change (type 0, or 254 and 255 without an event
     timer): while the inputs are steady it would be reported late, and with "Inputs when the node
     is lost" at "Set to 0" its inputs would read 0. The event timer checked is the EDS default when
     the master does not write it. The network checks offer to set the event timer to half the
     timeout, rounded down to the PLC cycle, or to clear the timeout when no event timer helps. It
     is written as `receive_timeout_ms` in `canopen.json` format version 2.
   - Under each PDO setting and the node heartbeat, the hint names the object it writes (for
     example `0x1800:05`). A setting the EDS leaves out or marks read-only is shown read-only, as the
     master does not write it.
   - **Startup SDOs**: values written after the PDO and heartbeat settings, in order, each time the
     node boots; rows can be reordered. Each row shows the object's name (with its array or record
     name), takes the data type from the EDS, offers TRUE/FALSE for a BOOLEAN, and shows the EDS
     default and range. **Add object** lists the useful objects only: it leaves out the PDO
     parameters and heartbeat the editor writes itself, entry counters (sub-index 0), objects mapped
     in an enabled RPDO and objects already in the list; **Show all objects** lists them too, with
     the reason. **Add by index** adds an object the EDS does not define. The master never stores
     values in the node (0x1010); startup SDOs to 0x1010 and 0x1011 are refused, and restoring
     defaults is the node's own option.
   - On the **Network** tab, a bit rate a node's EDS marks unsupported (`BaudRate_x=0`) is disabled
     and names the node.
5. Give entries aliases and bind variables to them, as with other remote I/O.

Problems that would stop the build are listed at the top of the editor as they appear.

**Run this network**, the switch in the editor's header, turns the whole network off and on. New
networks are on. A network that is off is left out of `conf/canopen.json` (when no network is on, the
bundle has no `conf/canopen.json` and the upload needs no runtime with CANopen), and the build log
names it. It keeps its nodes, mappings, addresses and aliases, so variables stay bound; its inputs
read 0 and its outputs go nowhere. Its problems are still listed, under "Fix these before turning the
network on", but do not stop the build, and checks between networks leave it out. The project tree
shows it dimmed with an **Off** tag.

## EDS and DCF files

**Check.** Every EDS or DCF file is checked against CiA 306 (`checkEds`) before a node is made from
it. The dialog lists the findings by rule, each with its clause, section, key and line; rules with
many findings are folded. Most findings are warnings and the node is added. Errors in the
communication area (0x1000-0x1FFF) that are not about limits only, and a file without
`[DeviceInfo]`, refuse the file: the dialog then has only **Close**. The file is read as UTF-8 (with
or without a byte order mark) or, failing that, as Windows-1252, with a warning, since CiA 306 asks
for ASCII. Objects whose `DataType` or `AccessType` cannot be read are left out of the node, with a
warning. Objects with `ObjFlags` bit 0 (refuse write on download) are never written by the master.
A `CompactPDO` file gets the PDOs it leaves implicit, numbered from the lowest free ones. PDO mapping
entries that name an object the file does not describe, or with a length other than the object's
type, are warned about. `[DeviceCommissioning]`, a common misspelling, is read as
`[DeviceComissioning]` with a warning. A modular device (`[SupportedModules]`) gets a warning: only
the base device's objects are used.

**Adding a node from a DCF.** A DCF with settings (`ParameterValue`, `[DeviceComissioning]`,
`Denotation`) offers **Take its settings** (the default) or **Use it only as a device description**.
Taking them sets the node ID (when it is free, else the lowest free one, with a warning), the name,
the PDOs, supervision, emergency, TIME, watching the master, heartbeat consumers and the reaction to
errors, turns other changed writable values into startup SDOs, and turns denotations of mapped
entries into aliases. The dialog lists what is taken and what is not (for example 0x1010 and 0x1011,
which are never written, or a heartbeat consumer for a node the network does not have), and warns
when the file's bit rate differs from the network's.

**Export.** **Export...** on a node page and **Export network...** at the top of the Network tab open
a dialog that asks for the format (`EXPORT_FORMATS` in `dcf-export.ts`; more formats are added there).

- **DCF** writes `node_<id>.dcf`: the node's EDS with a `ParameterValue` for every value the master
  writes at boot, `Denotation` for aliases, `[DeviceComissioning]` (node ID, name, bit rate, network
  name) and an updated `[FileInfo]`. Leading comments say that the master writes these values at each
  boot and that a node is reset to its defaults with 0x1011 sub 1 before taking them over. A mapping
  the device fixes is written too, so the DCF read back gives the same entries.
- **EDS** writes the stored file as it was added, unchanged, under its own name. A node added from a
  DCF gets that DCF without its values, names, commissioning and export comments, named after its
  `LastEDS`.

A network export writes one zip: a DCF per node, or an EDS per stored file. Each exported file is
checked again; the dialog shows the result per file and **Save** is disabled when one has an error.

**Replace EDS...** on a node page swaps the node's file for a newer one. The node keeps its ID, name,
PDO entries, aliases, startup SDOs and options where the new file still allows them; the dialog lists
what is not kept before anything changes.

**Storage.** The text of each file is kept in the network's device file
(`devices/remote/<name>.json`, `files`, by SHA-256), and each node names its file in `eds.source`
(format, file name, SHA-256), so a project exports DCFs without the original files. Files no node uses
are removed.

**Cross-check.** `.github/workflows/canopen-dcf-crosscheck.yml` compares the check, and the DCFs the
editor exports, with two independent checkers pinned to a commit: Lely's dcf-tools lint and the
EdsDcfNet checker, and reads the exported DCFs back with EdsDcfNet
(`.github/scripts/canopen-dcf-roundtrip/`) to compare their values and `[DeviceComissioning]` with the
editor's. EdsDcfNet follows CiA 306-1 v1.4.0; its warnings without an editor finding are listed as
notes in the job summary and do not fail it. It runs on pull requests to `canopen` that change the check, the parser, the DCF
import or export code, their fixtures or the cross-check files; otherwise the job is skipped. The
corpus and the editor's verdicts come from `__tests__/dcf-crosscheck-writer.test.ts`; the comparison
rules are in `.github/scripts/canopen_dcf_crosscheck.py`, and accepted differences, each with its
CiA 306 clause, in `.github/scripts/canopen-dcf-crosscheck-exceptions.json`.

## Startup and supervision options

The node page has a basic and an expert view; the **Expert view** switch is an editor preference,
kept across sessions and not in the project. The basic view shows the name, node ID, optional,
supervision, inputs on loss, watch the master with its timeout, and the state channel. The expert
view adds the settings below. An expert setting that is not at its default stays visible in the
basic view, marked "expert".

| Node setting                          | Effect                                                                                                                                                                                                          |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity check (expert)               | Vendor ID, product code and revision checked at boot                                                                                                                                                            |
| Optional node                         | The network runs without it; the master keeps looking for it and starts it when it appears                                                                                                                      |
| No initialization (expert)            | No identity check, restore or configuration SDOs; the master only starts the node, which keeps its settings                                                                                                     |
| Restore defaults (expert)             | Restores defaults through a writable 0x1011 sub (1 all, 2 comm, 3 app, 4+ manufacturer), resets, then configures the node                                                                                       |
| Node guarding                         | Writes 0x100C and 0x100D (and 0x1017 = 0); the master guards the node and loses it when it stops answering                                                                                                      |
| Heartbeats this node watches (expert) | Extra 0x1016 entries after the master's, for heartbeats of other nodes                                                                                                                                          |
| When the master is gone (expert)      | 0x1029:1 for a node that watches the master                                                                                                                                                                     |
| Emergency messages (expert)           | On by default; the COB-ID the master listens on, written to 0x1014 when it differs from the EDS. Off and greyed out when the EDS has no 0x1014; with a read-only 0x1014 the COB-ID is the EDS value, greyed out |
| Receive TIME (expert)                 | Writes 0x1012 so the node takes the network's TIME                                                                                                                                                              |

With **No initialization** the heartbeat or guarding values shown are the EDS defaults, read-only.
A setting the node cannot take is greyed out, and hovering it says why (the missing object, or No
initialization).

Network settings: **Boot-up timeout** (2000 ms) after which a mandatory node that is not up is
reported; **On node error** restarts the node and keeps trying, or stops it until the PLC restarts;
**SYNC window** is written to the 0x1007 of the nodes that have one; **Send TIME** makes the master
send the runtime's time of day on a COB-ID (0x100) and period; **Defaults for new nodes** pick the
supervision (automatic: heartbeat when the device has a writable 0x1017, else node guarding), the
heartbeat timeout as a percentage of the producer time (150 %) and whether emergencies are on
(nodes whose EDS has no 0x1014 get them off).

The editor checks the network as it is edited and lists the results at the top, errors (which
stop the build) and warnings (which do not), each with **Show** and, where there is one, a fix:
heartbeat timeouts not longer than the heartbeat (set to the default percentage), COB-ID clashes
(move to a free COB-ID), a startup SDO that makes a node a second SYNC producer (remove it), a SYNC
window not shorter than the SYNC period, restore on a node that is not initialized or has no such
sub-index (turn it off), heartbeats watched that no node sends, receive timeouts on TPDOs sent only
after a change (set an event timer or clear the timeout), and times that are not multiples of the
PLC cycle (round up). **Fix all** applies every fix as one change. These options need
`canopen.json` format version 3.

## Live status

While the editor is connected to a runtime whose `/api/capabilities` lists `"status"` in
`canopen.features`, the CANopen device editor reads `GET /api/canopen/status` once a second and shows:

- a dot before each node: green operational, amber booting or operational with an active emergency
  or a late PDO, red not answering, boot failed or lost, grey waiting, stopped, an optional node
  that is absent, or not in the running program; its tooltip gives the state and the reason;
- the bus status under the network header: the controller state, error counters, bus load and
  dropped frames, how often the runtime reset the link (after a bus-off, at a wrong bit rate or when
  it stopped sending), and, while the link is faulty, when the runtime is not permitted to reset it
  (reset it by hand then);
- a **Status** tab on each node: the state and since when, the reason of the last failure in words
  (for example "The product code is 0x43 where 0x42 was expected"), the NMT state, boot attempts and
  losses, the last emergencies with their code, error register bits and data, late PDOs, and the
  node's events with local times, and whether the node is optional or stopped after an error until
  the PLC restarts. A node held by a command from the online tools is "Held by you"; in service
  mode the nodes are "Service mode".

SDO abort codes, emergency codes (CiA 301 communication and protocol codes, else the class) and
error register bits are shown in words next to their values. When a read fails the last status stays,
greyed, with "Status unavailable". Nothing is shown when the editor is not connected or the runtime
does not list the feature. The polling stops when the device editor closes or the connection ends.
The network is matched by the device's name. A network that is off is not read: its header says
"Off in the project", with no dots and no Status tab.

## Online tools

While the editor is connected to a runtime that lists `"sdo"` in `canopen.features`, each node has an
**Online** tab. It sends its requests to `POST /api/canopen/request`;
SDO requests are jobs the editor polls after 10, 20 and 50 ms and then every 100 ms. The network is
the device's network in the runtime's status. A network that is off in the project has no Online tab
and no Open bus, and turning it off closes the service mode the editor opened.

- **Basic view (read only).** Every object of the node's EDS with index, name, type, access, the value
  in the project (the value the master writes at boot, marked with `*`, else the EDS default) and the
  value read from the node, in fixed columns that do not move while values load; long values wrap.
  When the tab is too narrow for a readable name, type and access move under the name and, in the
  expert view, the Write field under the node's value; narrower still, the project value moves under
  the node's value too. Search over index
  and name; filters for all objects, "Differs from project" (highlighted), writable objects and
  objects mapped in a PDO; Read per object and Read all with progress and Stop; decimal or hex;
  strings decoded. Read all goes on while another tab or node is shown and ends when done or stopped.
  A refused read shows a short text in the row and the abort code in words on hover.
  **Any object…** opens a reader for any index and sub-index, by data type or as raw hex bytes; an
  object the EDS lists starts with its EDS data type.
  The tools stay usable through two failed status reads in a row and grey out from the third.
  Refusals and failures show in red, a value that differs from the project on a light blue ground,
  and questions in an amber box.
- **Expert view.** A Write field on each writable object, with the same typed parsing and EDS limits
  as startup SDOs; the object is read back after the write, and the project is not changed. A write
  to an object the master writes at boot says that the value lasts until the node boots again.
  Problems and refusals show on a line under the row; when the node refuses a write with 0x08000022
  (not in its present state), that line offers to switch the node to pre-operational and write again.
  **Node state** shows the node's state and NMT state with the NMT buttons (Start, Pre-operational,
  Stop, Reset node, Reset communication); all but Start ask first. With **Send to all nodes of the
  network** ticked, the buttons send to every node and the question says so. Questions and results
  show to the right of the buttons, so the card keeps its size.
  **Node memory** has one Save to node (0x1010) and one Restore defaults (0x1011), each with a scope
  list holding only the scopes the EDS lists as writable sub-indexes. Each save scope is read when the
  tab opens: a scope the node does not save on command is left out, and one it saves by itself shows
  "(saves automatically)" with the button greyed; when the read fails the scope stays. Both ask first,
  to the right of the buttons, and after a restore the editor offers the reset that makes it take effect (reset
  communication for the communication scope, else reset node). When the node refuses a save or
  restore with 0x08000022, the card offers to switch it to pre-operational and try once more; after a
  retried restore the reset brings the node back, and after a retried save the card offers Start.
  Any object also writes; it never writes 0x1010 or 0x1011 and points to Node memory instead.
- **Service mode.** With the runtime's `"service"` feature and the PLC stopped, the network header
  offers **Open bus** (the node's Online tab offers it instead while that tab is shown), which opens
  service mode with the network's settings and nodes; the online tools then work as with a running PLC while the master sends nothing of its own.
  The NMT state follows the commands sent and the nodes' heartbeats and boot-ups.
  **Close bus** closes it, and so does closing the device editor; the runtime closes it before the
  PLC starts and after 5 minutes without a request.

## PLC function blocks

The editor ships the **canopen** library ("CANopen" in the library tree) with CiA 405 function blocks for the
project's CANopen networks. The project's first CANopen network turns it on; it can be turned off and
on in the project's libraries like any other. The blocks are C++ blocks that run inside the program and
hand each request to the runtime's canopen plugin, so a call never waits for the bus.

| Block                                 | What it does                                                       |
| ------------------------------------- | ------------------------------------------------------------------ |
| `SDO_READ4`, `SDO_WRITE4`             | Read or write an object of 1 to 4 bytes (`DATA : DWORD`)           |
| `SDO_READ_DATA`, `SDO_WRITE_DATA`     | Read or write up to 256 bytes (`DATA : ARRAY[0..255] OF BYTE`)     |
| `SDO_READ_STRING`, `SDO_WRITE_STRING` | Read or write a text object of up to 254 characters                |
| `NMT`                                 | Send an NMT command to a node, or with `DEVICE := 0` to every node |
| `GET_STATE`                           | A node's NMT state as the master sees it                           |
| `GET_LOCAL_NODE_ID`                   | The master's node ID                                               |
| `GET_CANOPEN_KERNEL_STATE`            | The bus state (no error, error passive, bus off, no driver)        |
| `RECV_EMCY`, `RECV_EMCY_DEV`          | Emergency messages of the network, or of one node, oldest first    |

- **Addressing.** `NETWORK` counts the networks that are on from 1 (default 1) and `DEVICE` is the node
  ID. Each network and node name is also a constant of the program, so `DEVICE := io2` and
  `NETWORK := line_1` work. A name must be an identifier, unique across the networks (case does not
  matter) and must not be a name of the project or of the library; the node page lists a clash and
  the build refuses it.
- **Handshake.** A rising edge of `ENABLE` starts a request. `BUSY` is TRUE until it ends, then
  `CONFIRM` or `ERROR` stays until `ENABLE` goes FALSE. `TIMEOUT := T#0s` uses the network's SDO
  timeout. The state blocks answer in the same call while `ENABLE` is TRUE. Instances are independent,
  so one block type can be used many times with different names.
- **Errors.** `ERROR` is a `CANOPEN_KERNEL_*` constant; `ERRORINFO` holds the SDO abort code when the
  node refused (`CANOPEN_KERNEL_OTHER_ERROR`) and `ERRORTEXT` says the same in words with the network,
  node and object. A runtime without the canopen plugin, or one too old, gives
  `CANOPEN_KERNEL_NO_DRIVER`.
- **Types.** STruC++ does not export a library's enumerations, so the CiA 405 enumerations are `USINT`
  types (`CANOPEN_KERNEL_ERROR`, `DEVICE_STATE`, `TRANSITION_STATE`) with their values as constants
  (`STOPPED`, `START_REMOTE_NODE`, ...). `CANOPEN_DWORD_TO_REAL` and `CANOPEN_REAL_TO_DWORD` keep every
  bit for REAL32 objects.
- **PLC stop and start.** A request in progress when the PLC stops is cancelled; after a start the
  blocks begin again from idle. `SDO_WRITE4` with `DATALENGTH := 0` takes the object's size from the
  node's EDS.

The library's sources are in `resources/libraries/canopen/` (`library.json`, `src/types.st`,
`src/shared.inc`) and the block templates in `src/backend/shared/canopen/library-blocks.ts`;
`npm run build:canopen-lib` writes `resources/libraries/canopen/blocks/` and
`resources/libraries/canopen.stlib`, and a unit test fails while they are stale. The names, the
constants and the EDS size table come from `src/middleware/shared/utils/canopen/plc-names.ts` and are
appended to the program at build time.

## Installing a release and the runtime check

This fork's releases are on its GitHub Releases page (`v<upstream version>-canopen.<N>`); installing one
replaces an installed OpenPLC Editor, and the update notice then offers newer releases of the fork. The
runtime's **Change version** dialog lists the runtime fork's releases. How releases are made is in
[canopen-releases.md](canopen-releases.md).

Before uploading a project with a CANopen device, the editor reads `canopen.configVersions` from the
runtime's `/api/capabilities`. A runtime without the CANopen plugin, or one that does not read the
project's `canopen.json` version, is refused with a message naming both versions, because it would
accept the upload and ignore the CANopen configuration. Projects without a CANopen device are not checked.

## Addresses

Entries take addresses from the central registry (`docs/iec-address-registry.md`): the consumer
kind is `canopen`, one consumer per node, and each entry's channel id is stable across edits. New
entries are written with a placeholder of the right class (`%IB0`, `%QX0.0`, ...) and
`projectActions.updateCanopenConfig` reallocates, so the placeholders land on free addresses. An
entry of a switched-off PDO has no address and no alias.

## Data model and code

| Piece                                                     | Where                                                                  |
| --------------------------------------------------------- | ---------------------------------------------------------------------- |
| Types (`CanopenConfig`, `CanopenNode`, `CanopenPdo`, ...) | `src/middleware/shared/ports/canopen-types.ts`                         |
| Project schema                                            | `CanopenConfigSchema` in `src/backend/shared/types/PLC/open-plc.ts`    |
| EDS parser                                                | `src/middleware/shared/utils/canopen/eds-parser.ts`                    |
| CiA 306 check (rules, file reader, values)                | `src/middleware/shared/utils/canopen/eds-check.ts`, `eds-document.ts`, `eds-values.ts` |
| DCF import, export and Replace EDS                        | `src/middleware/shared/utils/canopen/dcf-import.ts`, `dcf-export.ts`, `device-import.ts` |
| Node construction and edits                               | `src/middleware/shared/utils/canopen/model.ts`                         |
| Editing rules (transmission types, SDO objects, search)   | `src/middleware/shared/utils/canopen/editing.ts`                       |
| Build checks and editor warnings                          | `src/middleware/shared/utils/canopen/validate-canopen-config.ts`       |
| Checks with fixes                                         | `src/middleware/shared/utils/canopen/check-fix.ts`                     |
| `conf/canopen.json`                                       | `src/middleware/shared/utils/canopen/generate-canopen-config.ts`       |
| Store action                                              | `projectActions.updateCanopenConfig`                                   |
| Status answer schema                                      | `src/middleware/shared/ports/canopen-status.ts`                        |
| Status texts and code decoders                            | `src/middleware/shared/utils/canopen/diagnostics/`                     |
| Status polling                                            | `src/frontend/hooks/use-canopen-status.ts`                             |
| Online requests and answers                               | `src/middleware/shared/ports/canopen-online.ts`                        |
| Online tools (jobs, values, scopes)                       | `src/middleware/shared/utils/canopen/online.ts`                        |
| Online tools and service mode in the editor               | `src/frontend/hooks/use-canopen-online.ts`                             |
| Values read online and Read all, kept across tabs         | `src/frontend/hooks/use-canopen-online-reads.ts`                       |
| Device editor                                             | `src/frontend/components/_features/[workspace]/editor/device/canopen/` |

The parsed EDS (identity, PDO counts, object dictionary) is stored on the node, so a project opens
and builds without the original file. For each PDO the generator writes the configuration SDOs in
the CiA 301 order: disable the PDO (COB-ID bit 31), clear the mapping, write the entries, set the
count, write the transmission type, inhibit time and event timer, and enable it. TPDO COB-IDs are
written with bit 30 set (no RTR). A PDO that is
switched off or has no entries is only disabled. Objects the EDS marks read-only are not written.

## Tests

- Unit: `src/middleware/shared/utils/canopen/__tests__/` (parser, CiA 306 check with the fixtures in
  `fixtures/cia306/`, DCF import and export, model, editing rules, generator, validator,
  receive timeout, node options and checks, status schema and texts, online tools), the status polling in
  `src/frontend/hooks/__tests__/use-canopen-status.test.ts`
  with the generic I/O module EDS in `__tests__/fixtures/`, the store action in
  `src/frontend/store/__tests__/canopen-config.test.ts`, and the device editor in
  `.../device/canopen/__tests__/`.
- End-to-end: `e2e/canopen-*.spec.ts` drive the built app (Playwright, Electron). They cover adding a
  node from an EDS and building it, PDO and startup SDO editing, aliases, the Network tab settings and
  the bit rates the nodes support, the defaults for new nodes, the checks that stop a build and their
  fixes, receive timeouts, node options, EDS and DCF import and export, the basic and expert view, heartbeat consuming, emergency and
  TIME settings, turning a network off, the PLC block library and node names in a program, the upload check against a runtime without CANopen, and,
  against a fake runtime on port 8443 (`e2e/helpers/canopen-runtime.ts`), the live status, the Online
  tab, Save to node and Restore defaults, and service mode. Run them locally with
  `npx playwright test e2e/canopen-` after the build steps in CLAUDE.md ("Electron e2e").
- CI: `.github/workflows/canopen-ui.yml` runs them on every pull request to `canopen` that changes a
  path under `src/` or `e2e/` with `canopen` in it, an e2e helper, the dependencies or the workflow,
  and on upstream sync pull requests; for any other pull request the job is skipped. It builds the app
  once on `ubuntu-24.04` and runs the tests under `xvfb`. Their screenshots go to the `ci-screenshots`
  branch and one comment on the pull request, updated on each run.
- Key views are compared with the baselines in `e2e/<spec>-snapshots/` (`keyView` in
  `e2e/helpers/canopen-shots.ts`), in CI only, because the baselines are Linux renderings. A view that
  differs fails the job, and the comment shows the baseline, the new image and the difference. For an
  intended change, take the new images from the run's `canopen-ui-results` artifact
  (`<view>-actual.png`), save them as `e2e/<spec>-snapshots/<view>-chromium-linux.png` and commit.
- `e2e/layout-canopen-online.spec.ts` (local only, outside the CI glob) takes screenshots of the Online
  tab at a wide and a narrow window for a layout review, into `SCREENSHOT_DIR`.
  The runtime fork's CI builds `e2e/fixtures/canopen-generic-io/` with the editor CLI and runs it
  against a simulated node on a virtual CAN bus, and runs `e2e/fixtures/canopen-plc-blocks/`, a
  program that calls every block, against the same node across PLC stops and starts.
- PLC blocks: the names and constants in
  `src/middleware/shared/utils/canopen/__tests__/plc-names.test.ts`, the library build in
  `src/backend/shared/canopen/__tests__/build-library.test.ts` (it also fails while the committed
  archive is stale), the shipped libraries in the library manager's tests and the auto-enable in
  `src/frontend/store/__tests__/shared-slice.test.ts`.
