# CANopen — OpenPLC Editor

A CANopen network is a remote device with protocol `canopen`. The editor builds each node from its
EDS file, maps its PDOs to IEC locations, and writes everything the runtime's `canopen` plugin
needs into `conf/canopen.json`. The runtime never reads an EDS; its side, and the file format, are
described in the runtime's `docs/CANOPEN.md`.

```
EDS file → parseEds → createCanopenNode → project (remote device JSON)
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
   and the NMT state the nodes get when the PLC stops.
3. **Nodes** tab: **Add node from EDS file...** reads the file, picks the lowest free node ID and
   maps the PDOs the EDS defines by default. Set the node ID to the one set on the device.
4. For each node:
   - **General**: name, node ID, which identity values the master checks at boot (vendor ID and
     product code by default; the revision is off so newer firmware still boots), heartbeat
     supervision with the node's producer time and the master's timeout, what the node's inputs do
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
     than two SYNC intervals of a synchronous PDO on a fixed SYNC period, shows a warning. It is
     written as `receive_timeout_ms` in `canopen.json` format version 2.
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
     values in the node (0x1010) and never restores defaults (0x1011).
   - On the **Network** tab, a bit rate a node's EDS marks unsupported (`BaudRate_x=0`) is disabled
     and names the node.
5. Give entries aliases and bind variables to them, as with other remote I/O.

Problems that would stop the build are listed at the top of the editor as they appear.

## Live status

While the editor is connected to a runtime whose `/api/capabilities` lists `"status"` in
`canopen.features`, the CANopen device editor reads `GET /api/canopen/status` once a second and shows:

- a dot before each node: green operational, amber booting or operational with an active emergency
  or a late PDO, red not answering, boot failed or lost, grey waiting, stopped or not in the
  running program; its tooltip gives the state and the reason;
- the bus status under the network header: the controller state, error counters and bus load;
- a **Status** tab on each node: the state and since when, the reason of the last failure in words
  (for example "The product code is 0x43 where 0x42 was expected"), the NMT state, boot attempts and
  losses, the last emergencies with their code, error register bits and data, late PDOs, and the
  node's events with local times.

SDO abort codes, emergency codes (CiA 301 communication and protocol codes, else the class) and
error register bits are shown in words next to their values. When a read fails the last status stays,
greyed, with "Status unavailable". Nothing is shown when the editor is not connected or the runtime
does not list the feature. The polling stops when the device editor closes or the connection ends.
The network is matched by the device's name.

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
| Node construction and edits                               | `src/middleware/shared/utils/canopen/model.ts`                         |
| Editing rules (transmission types, SDO objects, search)   | `src/middleware/shared/utils/canopen/editing.ts`                       |
| Build checks and editor warnings                          | `src/middleware/shared/utils/canopen/validate-canopen-config.ts`       |
| `conf/canopen.json`                                       | `src/middleware/shared/utils/canopen/generate-canopen-config.ts`       |
| Store action                                              | `projectActions.updateCanopenConfig`                                   |
| Status answer schema                                      | `src/middleware/shared/ports/canopen-status.ts`                        |
| Status texts and code decoders                            | `src/middleware/shared/utils/canopen/diagnostics/`                     |
| Status polling                                            | `src/frontend/hooks/use-canopen-status.ts`                             |
| Device editor                                             | `src/frontend/components/_features/[workspace]/editor/device/canopen/` |

The parsed EDS (identity, PDO counts, object dictionary) is stored on the node, so a project opens
and builds without the original file. For each PDO the generator writes the configuration SDOs in
the CiA 301 order: disable the PDO (COB-ID bit 31), clear the mapping, write the entries, set the
count, write the transmission type, inhibit time and event timer, and enable it. TPDO COB-IDs are
written with bit 30 set (no RTR). A PDO that is
switched off or has no entries is only disabled. Objects the EDS marks read-only are not written.

## Tests

- Unit: `src/middleware/shared/utils/canopen/__tests__/` (parser, model, editing rules, generator, validator,
  receive timeout, status schema and texts), the status polling in
  `src/frontend/hooks/__tests__/use-canopen-status.test.ts`
  with the generic I/O module EDS in `__tests__/fixtures/`, the store action in
  `src/frontend/store/__tests__/canopen-config.test.ts`, and the device editor in
  `.../device/canopen/__tests__/`.
- End-to-end: `e2e/canopen-offline-build.spec.ts` adds a node from the EDS in the app and builds;
  `e2e/canopen-pdo-sdo-editing.spec.ts` reorders an entry, sets a transmission type and adds a
  startup SDO by search, then checks the built `canopen.json`;
  `e2e/canopen-watch-master.spec.ts` checks "Watch the master" and the bus priority in the build;
  `e2e/canopen-live-status.spec.ts` connects to a fake runtime on port 8443 and checks the dots,
  the Status tab and the reason of a failed boot, and that a runtime without the feature shows none
  of it.
  The runtime fork's CI builds `e2e/fixtures/canopen-generic-io/` with the editor CLI and runs it
  against a simulated node on a virtual CAN bus.
