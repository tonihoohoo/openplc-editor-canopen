// SPDX-License-Identifier: Apache-2.0
//
// canopen_slave.h - the board as a CiA 301 node on a CANopen master's bus, on its own CAN
// controller (ESP32 TWAI) with CANopenNode. The same behaviour as the runtime's CANopen slave:
// PDOs and SDOs to and from the program's located variables, heartbeat, the master's heartbeat
// watch, EMCY, 0x1029 and the PLC stop and start.
//
// All four calls compile to nothing when the project has no slave (CANOPEN_SLAVE_ENABLED 0 in
// the generated canopen_slave_config.h), so callers need no guard.

#ifndef CANOPEN_SLAVE_H
#define CANOPEN_SLAVE_H

#include "canopen_slave_config.h"

#ifdef __cplusplus
extern "C"
{
#endif

// Starts the CAN controller and the stack; from setup(), after the located variables are bound.
void canopen_slave_init(void);
// Receives, runs the stack and sends; from every loop() pass.
void canopen_slave_task(void);
// The master's values to the program's variables; before the scan.
void canopen_slave_scan_start(void);
// The program's values to the master; after the scan.
void canopen_slave_scan_end(void);

#ifdef __cplusplus
}
#endif

#endif // CANOPEN_SLAVE_H
