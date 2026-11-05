A Runtime v4 project with a CANopen slave (`slave`, node 5 on `vcan0`) and no CANopen network. The
master writes `Setpoint` and `Mode` (0x2000:01-02) in RPDO 1 and the parameter `Limit` (0x2000:03,
UNSIGNED16, default 1000, range 100 - 30000) by SDO. The program copies `Setpoint` to `Echo`
(0x2100:01) and `Limit` to `LimitEcho` (0x2100:02), which TPDO 1 sends on change. The slave sends a
heartbeat every 100 ms and watches the heartbeat of master node 127 (500 ms). `Serial` (0x2200:01)
is a STRING constant.

The runtime fork's CANopen workflow uploads it with the editor CLI and plays the master with
`.github/scripts/canopen_slave_e2e.py` on `vcan0`.
