/**
 * Meanings of the CiA 301 communication objects and the CiA 401 generic I/O objects, in our own
 * words: descriptions, units, value lists and bit fields. Shown only where a device file does not
 * describe the object itself. Pure.
 */

import type { CanopenObject, CanopenObjectInfo, CanopenValueMeaning } from '../../ports/canopen-types'

export type StandardSource = 'CiA 301' | 'CiA 401'

/** An object's information as shown: the file's own, completed by the standard's. */
export interface ShownObjectInfo extends CanopenObjectInfo {
  /** Set when any shown item comes from the standard rather than the file. */
  standard?: StandardSource
}

type Field = readonly [lsb: number, width: number, label: string]

const fields = (list: readonly Field[]): CanopenValueMeaning[] =>
  list.map(([lsb, width, label]) => (width > 1 ? { value: String(lsb), label, width } : { value: String(lsb), label }))

const values = (list: ReadonlyArray<readonly [number, string]>): CanopenValueMeaning[] =>
  list.map(([value, label]) => ({ value: String(value), label }))

const CAN_ID: readonly Field[] = [
  [0, 11, 'CAN-ID'],
  [29, 1, 'Frame: 29-bit CAN-ID'],
]
const SDO_COB_ID = fields([...CAN_ID, [30, 1, 'Dynamic'], [31, 1, 'Not valid']])
const MAPPING = fields([
  [0, 8, 'Length in bits'],
  [8, 8, 'Sub-index'],
  [16, 16, 'Index'],
])
const TRANSMISSION_TYPES = values([
  [0, 'Synchronous, acyclic'],
  [1, 'Synchronous, every SYNC'],
  [252, 'Synchronous, RTR only'],
  [253, 'Asynchronous, RTR only'],
  [254, 'Event-driven, manufacturer-specific'],
  [255, 'Event-driven, device profile'],
])
const ERROR_BEHAVIOUR = values([
  [0, 'Change to pre-operational (when operational)'],
  [1, 'No change of the NMT state'],
  [2, 'Change to stopped'],
])
const INHIBIT: CanopenObjectInfo = {
  description: 'Minimum time between two messages, in steps of 100 µs. 0: no inhibit time.',
  unit: 'ms',
  multiplier: 0.1,
}

const CIA301_SINGLE: Readonly<Record<number, CanopenObjectInfo>> = {
  0x1000: {
    description: 'Device profile number and additional information about the device.',
    bits: fields([
      [0, 16, 'Device profile number'],
      [16, 16, 'Additional information'],
    ]),
  },
  0x1001: {
    description: 'Summary of the errors active right now. Bit 0 is set whenever any error is active.',
    bits: fields([
      [0, 1, 'Generic error'],
      [1, 1, 'Current'],
      [2, 1, 'Voltage'],
      [3, 1, 'Temperature'],
      [4, 1, 'Communication error'],
      [5, 1, 'Device profile specific'],
      [7, 1, 'Manufacturer-specific'],
    ]),
  },
  0x1005: {
    description: 'CAN-ID of the SYNC message and whether this device produces it.',
    bits: fields([...CAN_ID, [30, 1, 'Generates SYNC']]),
  },
  0x1006: { description: 'SYNC interval in microseconds. 0: not used.', unit: 'µs' },
  0x1007: { description: 'Time window after SYNC for synchronous PDOs, in microseconds. 0: not used.', unit: 'µs' },
  0x100c: { description: 'Node guarding period. 0: node guarding off.', unit: 'ms' },
  0x100d: { description: 'Guard time multiplied by this factor gives the node life time.' },
  0x1012: {
    description: 'CAN-ID of the TIME message and whether this device produces or consumes it.',
    bits: fields([...CAN_ID, [30, 1, 'Produces TIME'], [31, 1, 'Consumes TIME']]),
  },
  0x1013: { description: 'Time stamp in microseconds.', unit: 'µs' },
  0x1014: {
    description: 'CAN-ID of the emergency message. Bit 31 set: the device sends no EMCY.',
    bits: fields([...CAN_ID, [31, 1, 'EMCY not valid']]),
  },
  0x1015: { ...INHIBIT, description: 'Minimum time between two EMCY messages, in steps of 100 µs.' },
  0x1017: { description: 'Interval of the heartbeat this device sends. 0: heartbeat off.', unit: 'ms' },
  0x1019: {
    description: 'Highest value of the SYNC counter (2 to 240). 0: SYNC without a counter.',
    values: values([[0, 'SYNC without a counter']]),
  },
}

function cia301(index: number, sub: number): CanopenObjectInfo | undefined {
  const single = CIA301_SINGLE[index]
  if (single && sub === 0) return single
  if (index === 0x1003 && sub === 0) return { description: 'Number of errors in the list. Writing 0 clears it.' }
  if (index === 0x1003 && sub >= 1)
    return {
      description: 'An earlier error, newest in sub-index 1.',
      bits: fields([
        [0, 16, 'Error code'],
        [16, 16, 'Manufacturer-specific information'],
      ]),
    }
  if (index === 0x1010 && sub >= 1)
    return {
      description: 'Write "save" (0x65766173) to store. A read tells how the device stores.',
      bits: fields([
        [0, 1, 'Saves on command'],
        [1, 1, 'Saves autonomously'],
      ]),
    }
  if (index === 0x1011 && sub >= 1)
    return {
      description: 'Write "load" (0x64616F6C) to restore the defaults; they take effect after a reset.',
      bits: fields([[0, 1, 'Restores on command']]),
    }
  if (index === 0x1016 && sub >= 1)
    return {
      description: 'Node-ID whose heartbeat is watched and the time before an error. 0: not used.',
      bits: fields([
        [0, 16, 'Heartbeat time (ms)'],
        [16, 8, 'Node-ID'],
      ]),
    }
  if (index === 0x1018 && sub === 3)
    return {
      bits: fields([
        [0, 16, 'Minor revision'],
        [16, 16, 'Major revision'],
      ]),
    }
  if (index === 0x1028 && sub >= 1) return { bits: fields([...CAN_ID, [31, 1, 'Not valid']]) }
  if (index === 0x1029 && sub >= 1)
    return { description: 'NMT state the device changes to when this error occurs.', values: ERROR_BEHAVIOUR }
  if (index >= 0x1200 && index <= 0x12ff && (sub === 1 || sub === 2)) return { bits: SDO_COB_ID }
  if (index >= 0x1280 && index <= 0x12ff && sub === 3) return { description: 'Node-ID of the SDO server.' }
  if (index >= 0x1400 && index <= 0x15ff) return pdoComm(sub, false)
  if (index >= 0x1800 && index <= 0x19ff) return pdoComm(sub, true)
  const mapping = (index >= 0x1600 && index <= 0x17ff) || (index >= 0x1a00 && index <= 0x1bff)
  if (mapping && sub === 0) return { description: 'Number of mapped objects. 0: mapping off while it is changed.' }
  if (mapping && sub >= 1) return { description: 'Object mapped into the PDO.', bits: MAPPING }
  return undefined
}

function pdoComm(sub: number, transmit: boolean): CanopenObjectInfo | undefined {
  switch (sub) {
    case 1:
      return {
        description: 'CAN-ID of the PDO. Bit 31 set: the PDO is not used.',
        bits: fields([...CAN_ID, ...(transmit ? [[30, 1, 'No RTR allowed'] as const] : []), [31, 1, 'PDO not valid']]),
      }
    case 2:
      return {
        description:
          'When the PDO is sent or taken over: 0 synchronous acyclic, 1 to 240 synchronous every n-th SYNC, 252 and 253 on RTR, 254 and 255 event-driven.',
        values: TRANSMISSION_TYPES,
      }
    case 3:
      return transmit ? INHIBIT : undefined
    case 5:
      return transmit
        ? { description: 'Cyclic transmission for event-driven PDOs. 0: off.', unit: 'ms' }
        : { description: 'Deadline monitoring of the received PDO. 0: off.', unit: 'ms' }
    case 6:
      return transmit ? { description: 'SYNC counter value at which the first PDO is sent.' } : undefined
    default:
      return undefined
  }
}

const eight = (word: string, sub: number): CanopenValueMeaning[] =>
  Array.from({ length: 8 }, (_, i) => ({ value: String(i), label: `${word} ${(sub - 1) * 8 + i + 1}` }))

const CIA401_BANKS: Readonly<Record<number, readonly [word: string, description: string]>> = {
  0x6000: ['Input', 'Digital inputs, one bit per input.'],
  0x6002: ['Input', 'A set bit inverts that input.'],
  0x6003: ['Input', 'A set bit switches the input filter on for that input.'],
  0x6006: ['Input', 'A set bit sends the inputs on any change of that input.'],
  0x6007: ['Input', 'A set bit sends the inputs on a rising edge of that input.'],
  0x6008: ['Input', 'A set bit sends the inputs on a falling edge of that input.'],
  0x6200: ['Output', 'Digital outputs, one bit per output.'],
  0x6202: ['Output', 'A set bit inverts that output.'],
  0x6206: ['Output', 'A set bit makes that output take its error value on a device failure.'],
  0x6207: ['Output', 'Value each output takes on a device failure when its error mode bit is set.'],
  0x6208: ['Output', 'A set bit lets the written value through to that output.'],
}

function cia401(index: number, sub: number): CanopenObjectInfo | undefined {
  const bank = CIA401_BANKS[index]
  if (bank && sub >= 1) return { description: bank[1], bits: eight(bank[0], sub) }
  if (index === 0x6005 && sub === 0)
    return {
      description: 'Enabled: a change of an input sends the inputs.',
      values: values([
        [0, 'Disabled'],
        [1, 'Enabled'],
      ]),
    }
  if (index === 0x6421 && sub >= 1)
    return {
      description: 'Which events of the analogue input send the inputs.',
      bits: fields([
        [0, 1, 'Upper limit exceeded'],
        [1, 1, 'Below lower limit'],
        [2, 1, 'Changed by more than delta'],
        [3, 1, 'Reduced by more than negative delta'],
        [4, 1, 'Increased by more than positive delta'],
      ]),
    }
  if (index === 0x6423 && sub === 0)
    return {
      description: 'Enabled: the analogue input events of 0x6421 send the inputs.',
      values: values([
        [0, 'Disabled'],
        [1, 'Enabled'],
      ]),
    }
  return undefined
}

/** The standard's information about an object, or undefined. */
export function standardInfo(
  index: number,
  subIndex: number,
): { info: CanopenObjectInfo; source: StandardSource } | undefined {
  const comm = index >= 0x1000 && index <= 0x1fff ? cia301(index, subIndex) : undefined
  if (comm) return { info: comm, source: 'CiA 301' }
  const io = index >= 0x6000 && index <= 0x9fff ? cia401(index, subIndex) : undefined
  return io ? { info: io, source: 'CiA 401' } : undefined
}

const STANDARD_KEYS = ['description', 'unit', 'multiplier', 'values', 'bits'] as const

/**
 * The information shown for an object: the file's own, with the standard's description, unit,
 * values and bits where the file has none of that kind. Bits and values come as a whole.
 */
export function objectInfo(object: CanopenObject | undefined): ShownObjectInfo | undefined {
  if (!object) return undefined
  const own = object.info
  const std = standardInfo(object.index, object.subIndex)
  if (!std) return own
  const shown: ShownObjectInfo = { ...own }
  let used = false
  for (const key of STANDARD_KEYS) {
    if (shown[key] !== undefined || std.info[key] === undefined) continue
    if (key === 'multiplier' && own?.unit !== undefined) continue
    Object.assign(shown, { [key]: std.info[key] })
    used = true
  }
  if (!used) return own
  shown.standard = std.source
  return shown
}

/** The meaning of a transmission type outside the standard's value list (1 to 240). */
export function standardValueMeaning(object: CanopenObject | undefined, n: number): string | undefined {
  if (!object || object.subIndex !== 2) return undefined
  const pdo = (object.index >= 0x1400 && object.index <= 0x15ff) || (object.index >= 0x1800 && object.index <= 0x19ff)
  if (!pdo || object.info?.values) return undefined
  if (n >= 2 && n <= 240) return `Synchronous, every ${n} SYNCs`
  if (n >= 241 && n <= 251) return 'Reserved'
  return undefined
}
