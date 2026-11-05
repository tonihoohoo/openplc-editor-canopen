The [CANopen slave project](../canopen-slave/README.md) with LSS on: the slave (`slave`, project node 5
on `vcan0`) waits for an LSS master's node ID and has the fixed serial number 23, so its LSS address
is vendor ID 0xABCD, product code 1, revision 0x00010000, serial 23.

The runtime fork's CANopen workflow uploads it with the editor CLI and plays the LSS master with
`.github/scripts/canopen_slave_lss_e2e.py` on `vcan0`: fastscan, node ID 12 configured and stored, the
boot-up as node 12, a reset node and the forget request.
