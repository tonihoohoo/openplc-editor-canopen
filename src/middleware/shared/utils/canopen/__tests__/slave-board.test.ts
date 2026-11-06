import { readFileSync } from 'fs'
import { join } from 'path'

import { PLCServerSchema } from '../../../../../backend/shared/types/PLC/open-plc'
import type { CanopenSlaveConfig } from '../../../ports/canopen-types'
import { defaultCanopenSlaveConfig } from '../slave'
import {
  canopenSlaveBoard,
  checkSlaveBoardBuild,
  gpioNumber,
  isCanopenSlaveBoard,
  slaveBoardProblems,
} from '../slave-board'
import {
  CANOPEN_SLAVE_CONFIG_DISABLED,
  generateSlaveBoardHeaders,
  parseSlaveLocation,
  slaveRawBytes,
} from '../slave-board-header'

const esp = (platform: string) => ({ compiler: 'arduino-cli', core: 'esp32:esp32', platform })
const BOARD = { controller: 'twai' as const, chip: 'esp32', txPin: 5, rxPin: 4 }

const boardConfig = (over: Partial<CanopenSlaveConfig> = {}): CanopenSlaveConfig => ({
  ...defaultCanopenSlaveConfig('io'),
  interface: '',
  bitrate: 500000,
  ...over,
})

const FIXTURE = join(
  __dirname,
  ...Array<string>(6).fill('..'),
  'e2e',
  'fixtures',
  'canopen-slave-board',
  'project',
  'devices',
  'servers',
  'slave.json',
)

const fixtureSlave = (): { name: string; config: CanopenSlaveConfig } => {
  const server = PLCServerSchema.parse(JSON.parse(readFileSync(FIXTURE, 'utf8')))
  if (!server.canopenSlaveConfig) throw new Error('fixture has no slave')
  return { name: server.name, config: server.canopenSlaveConfig }
}

describe('canopenSlaveBoard', () => {
  it('knows the ESP32 chips with a TWAI controller from the FQBN board part', () => {
    expect(canopenSlaveBoard(esp('esp32:esp32:esp32'))).toEqual(BOARD)
    expect(canopenSlaveBoard(esp('esp32:esp32:esp32s3'))?.chip).toBe('esp32s3')
    expect(canopenSlaveBoard(esp('esp32:esp32:XIAO_ESP32C3:FlashMode=dio'))?.chip).toBe('esp32c3')
    expect(canopenSlaveBoard(esp('esp32:esp32:esp32wrover'))?.chip).toBe('esp32')
    expect(canopenSlaveBoard(esp('esp32:esp32:esp32c6'))?.chip).toBe('esp32c6')
  })

  it('refuses chips without TWAI, other cores, Linux targets and missing boards', () => {
    expect(canopenSlaveBoard(esp('esp32:esp32:esp32p4'))).toBeNull()
    expect(canopenSlaveBoard({ compiler: 'arduino-cli', core: 'arduino:avr', platform: 'arduino:avr:mega' })).toBeNull()
    expect(canopenSlaveBoard({ compiler: 'openplc-compiler', platform: 'esp32:esp32:esp32' })).toBeNull()
    expect(canopenSlaveBoard({ compiler: 'arduino-cli', core: 'esp32:esp32' })).toBeNull()
    expect(canopenSlaveBoard(undefined)).toBeNull()
    expect(isCanopenSlaveBoard(esp('esp32:esp32:esp32'))).toBe(true)
    expect(isCanopenSlaveBoard(undefined)).toBe(false)
  })
})

describe('gpioNumber', () => {
  it('reads the usual pin spellings', () => {
    expect(gpioNumber('5')).toBe(5)
    expect(gpioNumber('GPIO17')).toBe(17)
    expect(gpioNumber(' io4 ')).toBe(4)
    expect(gpioNumber('D2')).toBe(2)
    expect(gpioNumber('A0')).toBeNull()
  })
})

describe('slaveBoardProblems', () => {
  it('has none for a plain slave on the default pins', () => {
    expect(slaveBoardProblems(boardConfig(), BOARD)).toEqual([])
  })

  it('names LSS, an unbuilt bit rate and a bit rate of zero', () => {
    const lss = boardConfig({ lss: { enabled: true, serial: 1 } })
    expect(slaveBoardProblems(lss, BOARD).map((p) => p.where)).toEqual(['lss'])
    expect(slaveBoardProblems(boardConfig({ bitrate: 20000 }), BOARD)[0]).toMatchObject({
      where: 'bitrate',
      text: expect.stringContaining('20 kbit/s') as unknown,
    })
    expect(slaveBoardProblems(boardConfig({ bitrate: 0 }), BOARD)[0].text).toContain('no interface')
  })

  it('names equal CAN pins and CAN pins the pin mapping also uses', () => {
    expect(slaveBoardProblems(boardConfig({ boardPins: { tx: 6, rx: 6 } }), BOARD)).toEqual([
      { where: 'pins', text: 'CAN TX and RX are both GPIO 6' },
    ])
    const pins = [
      { pin: 'GPIO4', address: '%IX0.0' },
      { pin: '12', address: '%QX0.0' },
    ]
    expect(slaveBoardProblems(boardConfig(), BOARD, pins)).toEqual([
      { where: 'pins', text: 'CAN RX GPIO 4 is also pin GPIO4 (%IX0.0) of the pin mapping' },
    ])
    expect(slaveBoardProblems(boardConfig({ boardPins: { tx: 21, rx: 22 } }), BOARD, pins)).toEqual([])
  })
})

describe('checkSlaveBoardBuild', () => {
  it('refuses two slaves on, ignores slaves off and warns about a slow cycle', () => {
    const two = checkSlaveBoardBuild({
      slaves: [
        { name: 'a', config: boardConfig() },
        { name: 'b', config: boardConfig() },
        { name: 'c', config: boardConfig({ enabled: false, bitrate: 1 }) },
      ],
      board: BOARD,
    })
    expect(two.errors).toEqual(['CANopen slaves "a", "b": a board has one CAN controller; turn all but one off'])

    const slow = checkSlaveBoardBuild({ slaves: [{ name: 'a', config: boardConfig() }], board: BOARD, cycleUs: 20000 })
    expect(slow).toEqual({
      errors: [],
      warnings: ['CANopen slave "a": the cycle time is 20 ms; above 10 ms, heartbeat and PDO timing follow the scan'],
    })
    expect(
      checkSlaveBoardBuild({ slaves: [{ name: 'a', config: boardConfig() }], board: BOARD, cycleUs: 5000 }).warnings,
    ).toEqual([])
  })

  it('prefixes each slave problem with its name', () => {
    const out = checkSlaveBoardBuild({ slaves: [{ name: 'a', config: boardConfig({ bitrate: 20000 }) }], board: BOARD })
    expect(out.errors).toEqual(['CANopen slave "a": 20 kbit/s is not on boards yet; pick 50 to 1000 kbit/s'])
  })
})

describe('slaveRawBytes and parseSlaveLocation', () => {
  it('writes values little-endian in the size of their type', () => {
    expect([...slaveRawBytes('-2', 'INTEGER16')]).toEqual([0xfe, 0xff])
    expect([...slaveRawBytes('0x1234', 'UNSIGNED32')]).toEqual([0x34, 0x12, 0, 0])
    expect([...slaveRawBytes('1.5', 'REAL32')]).toEqual([0, 0, 0xc0, 0x3f])
    expect([...slaveRawBytes('junk', 'UNSIGNED8')]).toEqual([0])
    expect([...slaveRawBytes('AB', 'VISIBLE_STRING')]).toEqual([0x41, 0x42])
  })

  it('reads located addresses and refuses malformed ones', () => {
    expect(parseSlaveLocation('%IW3')).toEqual({ area: 'I', size: 'W', index: 3, bit: 0 })
    expect(parseSlaveLocation('%qx1.7')).toEqual({ area: 'Q', size: 'X', index: 1, bit: 7 })
    expect(parseSlaveLocation('%IX1')).toBeNull()
    expect(parseSlaveLocation('%IW1.2')).toBeNull()
    expect(parseSlaveLocation('alias')).toBeNull()
  })
})

describe('generateSlaveBoardHeaders', () => {
  it('writes the disabled stub without a slave', () => {
    expect(generateSlaveBoardHeaders(null, BOARD)).toEqual({ configH: CANOPEN_SLAVE_CONFIG_DISABLED })
    expect(CANOPEN_SLAVE_CONFIG_DISABLED).toContain('#define CANOPEN_SLAVE_ENABLED 0')
  })

  it('writes the settings of the fixture slave', () => {
    const { configH } = generateSlaveBoardHeaders(fixtureSlave(), BOARD)
    for (const line of [
      '#define CANOPEN_SLAVE_ENABLED 1',
      '#define CANOPEN_SLAVE_NAME "slave"',
      '#define CANOPEN_SLAVE_TX_PIN 5',
      '#define CANOPEN_SLAVE_RX_PIN 4',
      '#define CANOPEN_SLAVE_KBIT 500',
      '#define CANOPEN_SLAVE_NODE_ID 5',
      '#define CANOPEN_SLAVE_START_ALONE 0',
      '#define CANOPEN_SLAVE_ZERO_ON_PLC_STOP 0',
      '#define CANOPEN_SLAVE_MASTER_NODE_ID 127',
    ])
      expect(configH).toContain(line)
    const pins = generateSlaveBoardHeaders(
      { name: 'x', config: { ...fixtureSlave().config, boardPins: { tx: 21, rx: 22 } } },
      BOARD,
    ).configH
    expect(pins).toContain('#define CANOPEN_SLAVE_TX_PIN 21')
    expect(pins).toContain('#define CANOPEN_SLAVE_RX_PIN 22')
  })

  it('writes a dictionary with the communication objects, the objects in order and a terminator', () => {
    const { odH } = generateSlaveBoardHeaders(fixtureSlave(), BOARD)
    if (!odH) throw new Error('no dictionary')
    const indexes = [...odH.matchAll(/^ {4}\{(0x[0-9A-F]{4}), \d+, ODT_(?:VAR|REC)/gm)].map((m) => Number(m[1]))
    expect(indexes).toEqual([...indexes].sort((a, b) => a - b))
    for (const i of [0x1000, 0x1001, 0x1003, 0x1005, 0x1008, 0x1014, 0x1016, 0x1017, 0x1018, 0x1029, 0x1200])
      expect(indexes).toContain(i)
    expect(indexes).toContain(0x1400)
    expect(indexes).toContain(0x1a00)
    expect(indexes).toContain(0x2000)
    expect(odH).toContain('{0x0000, 0, 0, NULL, NULL},')
    const count = Number(/static OD_t co_slave_od = \{(\d+), co_slave_list\}/.exec(odH)?.[1])
    expect(count).toBe(indexes.length)
  })

  it('puts the defaults in the data blob at aligned offsets', () => {
    const { odH } = generateSlaveBoardHeaders(fixtureSlave(), BOARD)
    if (!odH) throw new Error('no dictionary')
    const size = Number(/#define CO_SLAVE_DATA_BYTES (\d+)/.exec(odH)?.[1])
    const comm = Number(/#define CO_SLAVE_COMM_BYTES (\d+)/.exec(odH)?.[1])
    expect(size % 8).toBe(0)
    expect(comm % 8).toBe(0)
    expect(comm).toBeLessThan(size)
    const blob = /co_slave_defaults\[CO_SLAVE_DATA_BYTES\] = \{\n([\s\S]*?)\n\};/.exec(odH)?.[1] ?? ''
    const bytes = [...blob.matchAll(/0x([0-9A-F]{2})/g)].map((m) => parseInt(m[1], 16))
    expect(bytes).toHaveLength(size)
    for (const m of odH.matchAll(/\{&co_slave_data\[(\d+)\], (?:\d+, )?0x[0-9A-F]{2}, (\d+)\}/g)) {
      const off = Number(m[1])
      const len = Number(m[2])
      const align = len >= 8 ? 8 : len >= 4 ? 4 : len >= 2 ? 2 : 1
      expect(off % align).toBe(0)
      expect(off + Math.max(1, len)).toBeLessThanOrEqual(size)
    }
    // 0x1017 holds the heartbeat time of the fixture, 100 ms.
    const hb = /co_slave_1017 = \{&co_slave_data\[(\d+)\]/.exec(odH)
    const at = Number(hb?.[1])
    expect(bytes[at] | (bytes[at + 1] << 8)).toBe(100)
  })

  it('lists every application object with its range and locations', () => {
    const slave = fixtureSlave()
    const { odH } = generateSlaveBoardHeaders(slave, BOARD)
    if (!odH) throw new Error('no dictionary')
    expect(odH).toContain(`#define CO_SLAVE_OBJECTS ${slave.config.objects.length}`)
    const limit = slave.config.objects.find((o) => o.id === 'limit')
    if (!limit) throw new Error('fixture has no limit')
    expect(odH).toMatch(/\{0x2000, 3, 0, 1, 0, 2, 3, \d+, \d+, 1, 0x64ULL, 0x7530ULL\},/)
    expect(odH).toContain("{'I', 'W', 1, 0},")
  })

  it('maps the PDOs of the layout into 0x1600 and 0x1A00', () => {
    const { odH } = generateSlaveBoardHeaders(fixtureSlave(), BOARD)
    if (!odH) throw new Error('no dictionary')
    expect(odH).toMatch(/static OD_obj_record_t co_slave_1600\[9\]/)
    expect(odH).toMatch(/static OD_obj_record_t co_slave_1A00\[9\]/)
    expect(odH).toMatch(/static OD_obj_record_t co_slave_1400\[\d+\]/)
  })
})
