# CANopenNode for the board slave

The CANopen slave in the board firmware (`resources/sources/Baremetal/canopen_slave.*`) runs on
[CANopenNode](https://github.com/CANopenNode/CANopenNode) v4.1, the release the runtime fork's
CANopen plugin builds its slave on.

- `src/CANopen.*`, `src/301/`, `src/303/`, `src/304/`, `src/305/`, `src/309/`, `src/extra/` and
  `LICENSE` are copied unchanged from CANopenNode tag `v4.1`, commit
  `ac2140717c3c498d9b0351bce052bab630a74764` (Apache-2.0). Only the sources of the features the
  slave uses are kept; the headers `CANopen.h` includes are all kept.
- `src/CO_driver_target.h` and `src/co_driver.c` come from the runtime fork
  (`tonihoohoo/openplc-runtime-canopen`, `core/src/drivers/plugins/native/canopen/slave/`, commit
  `5fd7cae`, Apache-2.0): the stack's features and a CAN driver on a `SlaveCanPort`.

arduino-cli builds this folder as a library only when the firmware includes `CANopen.h`, which
`canopen_slave.cpp` does only in a build with a CANopen slave.
