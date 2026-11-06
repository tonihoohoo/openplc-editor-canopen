The `canopen-slave` project for an ESP32 board: the same objects, PDO layout and program, with the
slave in the board's firmware on its TWAI controller (GPIO 5 TX, GPIO 4 RX, 500 kbit/s) and no
network.

The runtime fork's CANopen workflow builds it with the editor CLI, starts the image in the ESP32
QEMU with the TWAI on `vcan0`, and plays the master with `.github/scripts/canopen_slave_e2e.py
--board`.
