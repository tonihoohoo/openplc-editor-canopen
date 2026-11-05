A Runtime v4 project with one CANopen network on `vcan0` and node 2 built from
`src/middleware/shared/utils/canopen/__tests__/fixtures/generic-io-module.eds`, with LSS support. Node 2
gets its node ID from the master over LSS: the master looks for the device with vendor ID 1, product
code 2, serial number 0x1001 and any revision, gives it node ID 2 and stores it in the device. The
program copies node 2's digital inputs (`%IB1`) to its digital outputs (`%QB0`).

The runtime fork's CANopen workflow uploads it with the editor CLI and runs it against
`canopen_sim_slave --interface vcan0 --node 255 --lss-serial 0x1001 --expect-lss-stores 1`, a
simulated module that starts without a node ID, and checks that the status shows node 2 given its ID
over LSS, stored and operational.
