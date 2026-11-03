A Runtime v4 project with one CANopen network on `vcan0`, built from
`src/middleware/shared/utils/canopen/__tests__/fixtures/generic-io-module.eds`. Node 2 (`io2`) is
started by the PLC program. Node 3 (`io3`) is mandatory, has no PDOs and is off at PLC start. The
program turns node 3 on with `CANOPEN_NODE_ENABLE`, waits for `CANOPEN_NETWORK_STATE.MANDATORY_UP`
and for node 2 to be in `RUN_WAITING_START` (`CANOPEN_NODE_STATUS`), starts node 2 with `NMT`, and
copies node 2's digital inputs (`%IB1`) to its digital outputs (`%QB0`).

The runtime fork's CANopen workflow uploads it with the editor CLI and runs it against
`canopen_sim_slave --interface vcan0 --node 2` and `--node 3`, and checks that the status shows
node 3 turned on by the program and node 2 started by it.
