A Runtime v4 project with one CANopen network on `vcan0` and node 2 built from
`src/middleware/shared/utils/canopen/__tests__/fixtures/generic-io-module.eds`. Node 9 is the same
module, optional, with no PDOs: no device answers on it, so the runtime reports it absent while the
network runs. The program copies node 2's digital inputs (`%IB1`) to its digital outputs (`%QB0`).

The runtime fork's CANopen workflow compiles and uploads it with the editor CLI and runs it against
`canopen_sim_slave --interface vcan0 --node 2`, and checks that the status shows node 2 operational
and node 9 absent.
