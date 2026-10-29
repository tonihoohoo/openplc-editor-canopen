/** CiA 301 codes as text: SDO abort codes, emergency error codes and the error register bits. */

export function hex(value: number, digits: number): string {
  return `0x${(value >>> 0).toString(16).toUpperCase().padStart(digits, '0')}`
}

const SDO_ABORTS: ReadonlyMap<number, string> = new Map([
  [0x05030000, 'Toggle bit not alternated'],
  [0x05040000, 'SDO protocol timed out'],
  [0x05040001, 'Client/server command specifier not valid or unknown'],
  [0x05040002, 'Invalid block size'],
  [0x05040003, 'Invalid sequence number'],
  [0x05040004, 'CRC error'],
  [0x05040005, 'Out of memory'],
  [0x06010000, 'Unsupported access to an object'],
  [0x06010001, 'Attempt to read a write only object'],
  [0x06010002, 'Attempt to write a read only object'],
  [0x06020000, 'Object does not exist in the object dictionary'],
  [0x06040041, 'Object cannot be mapped to the PDO'],
  [0x06040042, 'The number and length of the objects to be mapped would exceed the PDO length'],
  [0x06040043, 'General parameter incompatibility'],
  [0x06040047, 'General internal incompatibility in the device'],
  [0x06060000, 'Access failed due to a hardware error'],
  [0x06070010, 'Data type does not match, length of service parameter does not match'],
  [0x06070012, 'Data type does not match, length of service parameter too high'],
  [0x06070013, 'Data type does not match, length of service parameter too low'],
  [0x06090011, 'Sub-index does not exist'],
  [0x06090030, 'Invalid value for parameter'],
  [0x06090031, 'Value of parameter written too high'],
  [0x06090032, 'Value of parameter written too low'],
  [0x06090036, 'Maximum value is less than minimum value'],
  [0x060a0023, 'Resource not available: SDO connection'],
  [0x08000000, 'General error'],
  [0x08000020, 'Data cannot be transferred or stored to the application'],
  [0x08000021, 'Data cannot be transferred or stored to the application because of local control'],
  [0x08000022, 'Data cannot be transferred or stored to the application because of the present device state'],
  [0x08000023, 'Object dictionary dynamic generation fails or no object dictionary is present'],
  [0x08000024, 'No data available'],
])

/** The CiA 301 text of an SDO abort code. */
export function sdoAbortText(code: number): string {
  return SDO_ABORTS.get(code >>> 0) ?? 'Unknown abort code'
}

const EMCY_CODES: ReadonlyMap<number, string> = new Map([
  [0x0000, 'Error reset or no error'],
  [0x8100, 'Communication'],
  [0x8110, 'CAN overrun (objects lost)'],
  [0x8120, 'CAN in error passive mode'],
  [0x8130, 'Life guard or heartbeat error'],
  [0x8140, 'Recovered from bus off'],
  [0x8150, 'CAN-ID collision'],
  [0x8200, 'Protocol error'],
  [0x8210, 'PDO not processed due to length error'],
  [0x8220, 'PDO length exceeded'],
  [0x8230, 'DAM MPDO not processed, destination object not available'],
  [0x8240, 'Unexpected SYNC data length'],
  [0x8250, 'RPDO timeout'],
])

const EMCY_CLASSES: ReadonlyArray<[number, number, string]> = [
  [0x0000, 0x00ff, 'Error reset or no error'],
  [0x1000, 0x10ff, 'Generic error'],
  [0x2000, 0x20ff, 'Current'],
  [0x2100, 0x21ff, 'Current, device input side'],
  [0x2200, 0x22ff, 'Current inside the device'],
  [0x2300, 0x23ff, 'Current, device output side'],
  [0x3000, 0x30ff, 'Voltage'],
  [0x3100, 0x31ff, 'Mains voltage'],
  [0x3200, 0x32ff, 'Voltage inside the device'],
  [0x3300, 0x33ff, 'Output voltage'],
  [0x4000, 0x40ff, 'Temperature'],
  [0x4100, 0x41ff, 'Ambient temperature'],
  [0x4200, 0x42ff, 'Device temperature'],
  [0x5000, 0x50ff, 'Device hardware'],
  [0x6000, 0x60ff, 'Device software'],
  [0x6100, 0x61ff, 'Internal software'],
  [0x6200, 0x62ff, 'User software'],
  [0x6300, 0x63ff, 'Data set'],
  [0x7000, 0x70ff, 'Additional modules'],
  [0x8000, 0x80ff, 'Monitoring'],
  [0x8100, 0x81ff, 'Communication'],
  [0x8200, 0x82ff, 'Protocol error'],
  [0x9000, 0x90ff, 'External error'],
  [0xf000, 0xf0ff, 'Additional functions'],
  [0xff00, 0xffff, 'Device specific'],
]

/** The text of an emergency error code: the CiA 301 code when known, else its class. */
export function emcyText(code: number): string {
  const known = EMCY_CODES.get(code)
  if (known) return known
  const cls = EMCY_CLASSES.find(([lo, hi]) => code >= lo && code <= hi)
  return cls ? `${cls[2]} (class)` : 'Unknown error code'
}

const REGISTER_BITS = [
  'generic',
  'current',
  'voltage',
  'temperature',
  'communication',
  'device profile specific',
  'reserved',
  'manufacturer specific',
] as const

/** The names of the bits set in an error register (object 0x1001). */
export function errorRegisterBits(register: number): string[] {
  return REGISTER_BITS.filter((_, bit) => (register & (1 << bit)) !== 0)
}

/** The 5 manufacturer bytes of an emergency, spaced for reading. */
export function emcyDataText(data: string): string {
  return (data.match(/[0-9a-fA-F]{2}/g) ?? []).map((b) => b.toUpperCase()).join(' ')
}
