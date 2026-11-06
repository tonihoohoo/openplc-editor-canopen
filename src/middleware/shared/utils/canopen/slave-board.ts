/**
 * CANopen slave on a microcontroller board: which boards have a CAN controller the firmware
 * drives, and their default CAN pins. Keyed on the board's Arduino core and the chip in its
 * FQBN, so the signed board packages stay untouched; a package's own `canopenSlave` capability
 * wins over the table.
 */

import type { CanopenSlaveConfig } from '../../ports/canopen-types'

/** CAN controller the firmware module drives. */
export type CanopenSlaveController = 'twai'

export interface CanopenSlaveBoardProfile {
  controller: CanopenSlaveController
  /** Chip id from the FQBN board part, e.g. `esp32s3`. */
  chip: string
  /** Default TX and RX GPIO numbers. */
  txPin: number
  rxPin: number
}

/** ESP32 chips with a TWAI controller, and their default CAN pins. */
const TWAI_CHIPS: Readonly<Record<string, { txPin: number; rxPin: number }>> = {
  esp32: { txPin: 5, rxPin: 4 },
  esp32s2: { txPin: 5, rxPin: 4 },
  esp32s3: { txPin: 5, rxPin: 4 },
  esp32c3: { txPin: 5, rxPin: 4 },
  esp32c6: { txPin: 5, rxPin: 4 },
  esp32h2: { txPin: 5, rxPin: 4 },
}

/** The chip an ESP32 FQBN builds for, from the chip name in its board part (`esp32s3`,
 *  `xiao_esp32c3`, `esp32wrover`); null for a chip without TWAI. */
function esp32Chip(platform: string): string | null {
  const parts = platform.split(':')
  if (parts.length < 3 || parts[0] !== 'esp32' || parts[1] !== 'esp32') return null
  const match = /esp32([a-z]\d)?/.exec(parts[2].toLowerCase())
  if (!match) return null
  const chip = `esp32${match[1] ?? ''}`
  return chip in TWAI_CHIPS ? chip : null
}

/** The board's CAN profile, or null when the firmware cannot run a CANopen slave on it. */
export function canopenSlaveBoard(
  board: { compiler?: string; core?: string; platform?: string } | undefined,
): CanopenSlaveBoardProfile | null {
  if (!board || board.compiler !== 'arduino-cli') return null
  if (board.core !== undefined && board.core !== 'esp32:esp32') return null
  const chip = board.platform ? esp32Chip(board.platform) : null
  if (!chip) return null
  return { controller: 'twai', chip, ...TWAI_CHIPS[chip] }
}

/** True when the board runs the slave in its firmware (not on Linux). */
export function isCanopenSlaveBoard(board: Parameters<typeof canopenSlaveBoard>[0]): boolean {
  return canopenSlaveBoard(board) !== null
}

/** Kbit/s the board's controller is built for. */
export const SLAVE_BOARD_BITRATES = [50000, 125000, 250000, 500000, 800000, 1000000] as const

/** Above this cycle time, PDO data and the heartbeat follow the scan rather than the bus. */
export const SLAVE_BOARD_MAX_CYCLE_MS = 10

/** The GPIO number of a pin name (`5`, `GPIO5`, `IO5`, `D5`), or null. */
export function gpioNumber(pin: string): number | null {
  const m = /^(?:gpio|io|d)?(\d+)$/i.exec(pin.trim())
  return m ? Number(m[1]) : null
}

export interface SlaveBoardBuildCheck {
  errors: string[]
  warnings: string[]
}

/**
 * What stops a board build with CANopen slaves, and what it warns about: one slave at most, no
 * LSS, a bit rate the controller is built for, two different CAN pins that the pin mapping does
 * not use, and a cycle time the bus timing can follow.
 */
export function checkSlaveBoardBuild(input: {
  slaves: readonly { name: string; config: CanopenSlaveConfig }[]
  board: CanopenSlaveBoardProfile
  pins?: readonly { pin: string; address: string }[]
  /** The PLC cycle (`plcCycleUs`), null without a cyclic task. */
  cycleUs?: number | null
}): SlaveBoardBuildCheck {
  const errors: string[] = []
  const warnings: string[] = []
  const on = input.slaves.filter((s) => s.config.enabled)
  if (on.length > 1)
    errors.push(
      `CANopen slaves ${on.map((s) => `"${s.name}"`).join(', ')}: a board has one CAN controller; turn all but one off`,
    )
  for (const { name, config } of on) {
    const what = `CANopen slave "${name}"`
    if (config.lss?.enabled) errors.push(`${what}: LSS is not on boards yet; turn LSS off`)
    if (!SLAVE_BOARD_BITRATES.some((b) => b === config.bitrate))
      errors.push(`${what}: ${config.bitrate / 1000} kbit/s is not on boards yet; use 50 to 1000 kbit/s`)
    const tx = config.boardPins?.tx ?? input.board.txPin
    const rx = config.boardPins?.rx ?? input.board.rxPin
    if (tx === rx) errors.push(`${what}: CAN TX and RX are both GPIO ${tx}`)
    for (const p of input.pins ?? []) {
      const gpio = gpioNumber(p.pin)
      if (gpio !== null && (gpio === tx || gpio === rx))
        errors.push(
          `${what}: CAN ${gpio === tx ? 'TX' : 'RX'} GPIO ${gpio} is also pin ${p.pin} (${p.address}) of the pin mapping`,
        )
    }
  }
  if (on.length > 0) {
    const cycle = input.cycleUs ? input.cycleUs / 1000 : null
    if (cycle !== null && cycle > SLAVE_BOARD_MAX_CYCLE_MS)
      warnings.push(
        `CANopen slave "${on[0].name}": the cycle time is ${cycle} ms; above ${SLAVE_BOARD_MAX_CYCLE_MS} ms, heartbeat and PDO timing follow the scan`,
      )
  }
  return { errors, warnings }
}
