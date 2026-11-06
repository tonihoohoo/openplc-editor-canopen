A Runtime v4 project with a CANopen slave (`io`, node 5 on `vcan0`) whose program uses the `linux_io`
blocks on lines of the kernel's GPIO simulator named `lio-in`, `lio-out` and `lio-on`. The level of
`lio-in` goes to the master in TPDO 1 (`Inputs`, 0x2100:01, bit 0; bits 1-3 are the `VALID` outputs
of the input, the outputs and the value read). The master's RPDO 1 (`Outputs`, 0x2000:01) drives
`lio-out` with bit 0 (off on a PLC stop) and `lio-on` with bit 1 (`ON_STOP := LIO_STOP_ON`, on on a
PLC stop). `READ_VALUE` reads `/sys/class/net/lo/mtu` into `Mtu` (0x2100:02); the blocks' `ERROR`
outputs are 0x2100:03-05, all by SDO.

The runtime fork's CANopen workflow creates the simulated lines, uploads the project with the editor
CLI and plays the master with `.github/scripts/linux_io_e2e.py` on `vcan0`.
