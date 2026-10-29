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
   "Leave as configured" for a link set up outside the runtime), the master node ID, SYNC (none,
   once per PLC cycle, or a fixed period) and the NMT state the nodes get when the PLC stops.
3. **Nodes** tab: **Add node from EDS file...** reads the file, picks the lowest free node ID and
   maps the PDOs the EDS defines by default. Set the node ID to the one set on the device.
4. For each node:
   - **General**: name, node ID, which identity values the master checks at boot (vendor ID and
     product code by default; the revision is off so newer firmware still boots), heartbeat
     supervision with the node's producer time and the master's timeout, what the node's inputs do
     when it is lost, and the `%IB` that reads its NMT state.
   - **Inputs** / **Outputs**: the node's transmit PDOs (PLC inputs, `%I`) and receive PDOs (PLC
     outputs, `%Q`). A PDO can be switched off, its COB-ID and transmission type changed, and its
     entries removed or added from the objects the EDS marks as mappable. An entry that would take
     the PDO over 64 bits is offered but disabled. A mapping the EDS marks read-only is fixed.
   - **Startup SDOs**: values written after the PDO and heartbeat settings, in order, each time the
     node boots. The master never stores them in the node (0x1010) and never restores defaults
     (0x1011).
5. Give entries aliases and bind variables to them, as with other remote I/O.

Problems that would stop the build are listed at the top of the editor as they appear.

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
| Build checks and editor warnings                          | `src/middleware/shared/utils/canopen/validate-canopen-config.ts`       |
| `conf/canopen.json`                                       | `src/middleware/shared/utils/canopen/generate-canopen-config.ts`       |
| Store action                                              | `projectActions.updateCanopenConfig`                                   |
| Device editor                                             | `src/frontend/components/_features/[workspace]/editor/device/canopen/` |

The parsed EDS (identity, PDO counts, object dictionary) is stored on the node, so a project opens
and builds without the original file. For each PDO the generator writes the configuration SDOs in
the CiA 301 order: disable the PDO (COB-ID bit 31), clear the mapping, write the entries, set the
count, write the transmission type, inhibit time and event timer, and enable it. A PDO that is
switched off or has no entries is only disabled. Objects the EDS marks read-only are not written.

## Tests

- Unit: `src/middleware/shared/utils/canopen/__tests__/` (parser, model, generator, validator)
  with the generic I/O module EDS in `__tests__/fixtures/`, the store action in
  `src/frontend/store/__tests__/canopen-config.test.ts`, and the device editor in
  `.../device/canopen/__tests__/`.
- End-to-end: `e2e/canopen-offline-build.spec.ts` adds a node from the EDS in the app and builds.
  The runtime fork's CI builds `e2e/fixtures/canopen-generic-io/` with the editor CLI and runs it
  against a simulated node on a virtual CAN bus.
