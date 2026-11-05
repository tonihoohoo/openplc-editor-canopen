A Runtime v4 project with a CANopen slave (`io`, node 5 on `vcan0`) whose program uses the slave
blocks of the `canopen` library. On a PLC stop the slave goes pre-operational (0x1029:02). The
master writes `Command` (0x2000:01) and `Alarm` (0x2000:02) by SDO and reads, by SDO, the status
block's `STATE` (0x2100:01), the write counter of `Alarm` (0x2100:02), the error register
(0x2100:03) and the `ERROR` of the emergency (0x2100:04) and NMT (0x2100:05) blocks. While `Alarm`
is not 0 the program raises EMCY 4210h with `INFO` = `Alarm` (6200h when `Alarm` is 6200, which the
block refuses). While `Command` is not 0 it asks for pre-operational (1), operational (2) or a reset
node (3, refused).

The runtime fork's CANopen workflow uploads it with the editor CLI and plays the master with
`.github/scripts/canopen_slave_blocks_e2e.py` on `vcan0`.
