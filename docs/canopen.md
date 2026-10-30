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
   and the NMT state the nodes get when the PLC stops. Further groups set the startup and error
   behaviour, TIME and the defaults for new nodes (see "Startup and supervision options").
3. **Nodes** tab: **Add node from EDS file...** reads the file, picks the lowest free node ID and
   maps the PDOs the EDS defines by default. Set the node ID to the one set on the device.
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

## Startup and supervision options

The node page has a basic and an expert view; the **Expert view** switch is an editor preference,
kept across sessions and not in the project. The basic view shows the name, node ID, optional,
supervision, inputs on loss, watch the master with its timeout, and the state channel. The expert
view adds the settings below. An expert setting that is not at its default stays visible in the
basic view, marked "expert".

| Node setting                          | Effect                                                                                                      |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Identity check (expert)               | Vendor ID, product code and revision checked at boot                                                        |
| Optional node                         | The network runs without it; the master keeps looking for it and starts it when it appears                  |
| No initialization (expert)            | No identity check, restore or configuration SDOs; the master only starts the node, which keeps its settings |
| Restore defaults (expert)             | Restores defaults through a writable 0x1011 sub (1 all, 2 comm, 3 app, 4+ manufacturer), resets, then configures the node |
| Node guarding                         | Writes 0x100C and 0x100D (and 0x1017 = 0); the master guards the node and loses it when it stops answering  |
| Heartbeats this node watches (expert) | Extra 0x1016 entries after the master's, for heartbeats of other nodes                                      |
| When the master is gone (expert)      | 0x1029:1 for a node that watches the master                                                                 |
| Emergency messages (expert)           | On by default; the COB-ID the master listens on, written to 0x1014 when it differs from the EDS. Off and greyed out when the EDS has no 0x1014; with a read-only 0x1014 the COB-ID is the EDS value, greyed out |
| Receive TIME (expert)                 | Writes 0x1012 so the node takes the network's TIME                                                          |

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
sub-index (turn it off), heartbeats watched that no node sends, and times that are not multiples of
the PLC cycle (round up). **Fix all** applies every fix as one change. These options need
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
  the PLC restarts.

SDO abort codes, emergency codes (CiA 301 communication and protocol codes, else the class) and
error register bits are shown in words next to their values. When a read fails the last status stays,
greyed, with "Status unavailable". Nothing is shown when the editor is not connected or the runtime
does not list the feature. The polling stops when the device editor closes or the connection ends.
The network is matched by the device's name. A network that is off is not read: its header says
"Off in the project", with no dots and no Status tab.

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
| Checks with fixes                                         | `src/middleware/shared/utils/canopen/check-fix.ts`                     |
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
  receive timeout, node options and checks, status schema and texts), the status polling in
  `src/frontend/hooks/__tests__/use-canopen-status.test.ts`
  with the generic I/O module EDS in `__tests__/fixtures/`, the store action in
  `src/frontend/store/__tests__/canopen-config.test.ts`, and the device editor in
  `.../device/canopen/__tests__/`.
- End-to-end: `e2e/canopen-offline-build.spec.ts` adds a node from the EDS in the app and builds;
  `e2e/canopen-pdo-sdo-editing.spec.ts` reorders an entry, sets a transmission type and adds a
  startup SDO by search, then checks the built `canopen.json`;
  `e2e/canopen-watch-master.spec.ts` checks "Watch the master" and the bus priority in the build;
  `e2e/canopen-node-options.spec.ts` sets node options in the expert view, uses a fix, and checks
  the built `canopen.json`;
  `e2e/canopen-live-status.spec.ts` connects to a fake runtime on port 8443 and checks the dots,
  the Status tab and the reason of a failed boot, and that a runtime without the feature shows none
  of it.
  The runtime fork's CI builds `e2e/fixtures/canopen-generic-io/` with the editor CLI and runs it
  against a simulated node on a virtual CAN bus.
