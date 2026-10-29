A Runtime v4 project with one CANopen network on `vcan0` and node 2 built from
`src/middleware/shared/utils/canopen/__tests__/fixtures/generic-io-module.eds`. The program copies
the node's digital inputs (`%IB1`) to its digital outputs (`%QB0`).

The runtime fork's CANopen workflow compiles and uploads it with the editor CLI and runs it against
`canopen_sim_slave --interface vcan0 --node 2`.
