import type { CanopenConfig, CanopenNode, CanopenObjectInfo } from '../../../ports/canopen-types'
import {
  buildDbc,
  dbcExportOptions,
  dbcFrameUnavailable,
  dbcNetworkFileName,
  dbcNumber,
  dbcOptionLosses,
  defaultDbcExportOptions,
  withDbcExportOptions,
} from '../dbc-export'
import {
  buildNetworkExport,
  buildNodeExport,
  exportFileType,
  exportLosses,
  exportNeedsDeviceFile,
} from '../device-export'
import { configWith, genericNode } from './fixtures/helpers'

type Range = [number, number]
interface Sig {
  name: string
  start: number
  length: number
  signed: boolean
  factor: number
  offset: number
  unit: string
  float: boolean
  muxer: boolean
  muxedBy?: { muxer: string; ranges: Range[] }
}
interface Msg {
  id: number
  name: string
  dlc: number
  transmitter: string
  signals: Sig[]
}

/** A small reader of the DBC subset the writer produces, with extended multiplexing. */
function parse(text: string) {
  const messages = new Map<number, Msg>()
  const values = new Map<string, Map<string, string>>()
  let current: Msg | undefined
  for (const line of text.split('\r\n')) {
    let m = /^BO_ (\d+) (\w+): (\d+) (\w+)$/.exec(line)
    if (m) {
      current = { id: Number(m[1]), name: m[2], dlc: Number(m[3]), transmitter: m[4], signals: [] }
      messages.set(current.id, current)
      continue
    }
    m = /^ SG_ (\w+) (?:(M|m\d+M?) )?: (\d+)\|(\d+)@1([+-]) \(([^,]+),([^)]+)\) \[[^\]]*\] "([^"]*)"/.exec(line)
    if (m && current) {
      current.signals.push({
        name: m[1],
        start: Number(m[3]),
        length: Number(m[4]),
        signed: m[5] === '-',
        factor: Number(m[6]),
        offset: Number(m[7]),
        unit: m[8],
        float: false,
        muxer: m[2] !== undefined && m[2].endsWith('M'),
      })
      continue
    }
    m = /^SG_MUL_VAL_ (\d+) (\w+) (\w+) (.*);$/.exec(line)
    if (m) {
      const signal = m[2]
      const sig = messages.get(Number(m[1]))?.signals.find((s) => s.name === signal)
      if (sig)
        sig.muxedBy = {
          muxer: m[3],
          ranges: m[4].split(', ').map((r): Range => {
            const [a, b] = r.split('-').map(Number)
            return [a, b]
          }),
        }
      continue
    }
    m = /^SIG_VALTYPE_ (\d+) (\w+) : [12];$/.exec(line)
    if (m) {
      const signal = m[2]
      const sig = messages.get(Number(m[1]))?.signals.find((s) => s.name === signal)
      if (sig) sig.float = true
      continue
    }
    m = /^VAL_ (\d+) (\w+) (.*) ;$/.exec(line)
    if (m) {
      const table = new Map<string, string>()
      for (const v of m[3].matchAll(/(-?\d+) "((?:[^"\\]|\\.)*)"/g)) table.set(v[1], v[2])
      values.set(`${m[1]}/${m[2]}`, table)
    }
  }
  return { messages, values }
}

function rawValue(data: number[], s: Sig): bigint {
  let v = 0n
  for (let i = 0; i < s.length; i++) {
    const bit = s.start + i
    if ((data[bit >> 3] >> (bit & 7)) & 1) v |= 1n << BigInt(i)
  }
  if (s.signed && v & (1n << BigInt(s.length - 1))) v -= 1n << BigInt(s.length)
  return v
}

/** Decodes a frame; throws when a multiplexer selects no branch, as a strict DBC reader does. */
function decode(text: string, id: number, hex: string): Record<string, string | number> {
  const { messages, values } = parse(text)
  const msg = messages.get(id)
  if (!msg) throw new Error(`no message 0x${id.toString(16)}`)
  const data = hex.split(' ').map((b) => parseInt(b, 16))
  const raw = new Map<string, bigint>()
  const active = (s: Sig): boolean => {
    if (!s.muxedBy) return true
    const parent = msg.signals.find((p) => p.name === s.muxedBy?.muxer)
    if (!parent || !active(parent)) return false
    const v = Number(raw.get(parent.name) ?? rawValue(data, parent))
    return s.muxedBy.ranges.some(([a, b]) => v >= a && v <= b)
  }
  const out: Record<string, string | number> = {}
  for (const s of msg.signals) {
    if (!active(s)) continue
    const v = rawValue(data, s)
    raw.set(s.name, v)
    const named = values.get(`${id}/${s.name}`)?.get(v.toString())
    if (s.float) {
      const buf = new DataView(new ArrayBuffer(4))
      buf.setUint32(0, Number(BigInt.asUintN(32, v)), true)
      out[s.name] = buf.getFloat32(0, true)
    } else out[s.name] = named ?? Number(v) * s.factor + s.offset
  }
  for (const s of msg.signals.filter((x) => x.muxer && active(x))) {
    const v = Number(raw.get(s.name))
    if (!msg.signals.some((c) => c.muxedBy?.muxer === s.name && c.muxedBy.ranges.some(([a, b]) => v >= a && v <= b)))
      throw new Error(`${s.name} selects no branch for ${v}`)
  }
  return out
}

function withInfo(node: CanopenNode, index: number, subIndex: number, info: CanopenObjectInfo): CanopenNode {
  return {
    ...node,
    eds: {
      ...node.eds,
      objects: node.eds.objects.map((o) => (o.index === index && o.subIndex === subIndex ? { ...o, info } : o)),
    },
  }
}

const sigNamed = (text: string, id: number, name: string): Sig | undefined =>
  parse(text)
    .messages.get(id)
    ?.signals.find((s) => s.name === name)

function network(): CanopenConfig {
  const io2 = genericNode(2)
  let ai3: CanopenNode = { ...genericNode(3), name: 'ai3' }
  ai3 = withInfo(ai3, 0x6401, 1, { unit: 'degC', multiplier: 0.1, label: 'Temperature' })
  return configWith(io2, ai3)
}

describe('DBC export: PDOs', () => {
  it('writes a scaled XDD input with its unit and factor', () => {
    const config = network()
    const ai3 = config.nodes[1]
    const tpdo = ai3.tpdos.find((p) => p.entries.some((e) => e.index === 0x6401))
    expect(tpdo).toBeDefined()
    if (!tpdo) return
    const dbc = buildDbc(config, { networkName: 'canopen1' })
    expect(dbc.problems).toEqual([])
    const s = sigNamed(dbc.text, tpdo.cobId, 'ai3_Temperature')
    expect(s).toMatchObject({ length: 16, signed: true, factor: 0.1, unit: 'degC' })
    const bytes = new Array<string>(8).fill('00')
    const start = (s?.start ?? 0) / 8
    bytes[start] = 'EB'
    const values = decode(dbc.text, tpdo.cobId, bytes.slice(0, parse(dbc.text).messages.get(tpdo.cobId)?.dlc).join(' '))
    expect(values.ai3_Temperature).toBeCloseTo(23.5)
  })

  it('names a signal by its alias and leaves a gap for a dummy entry', () => {
    const node = genericNode(2)
    const rpdo = { ...node.rpdos[0] }
    const [first] = rpdo.entries
    rpdo.entries = [
      { ...first, alias: 'lamps' },
      { channelId: 'gap', index: 0x0005, subIndex: 0, name: 'dummy', dataType: 'UNSIGNED8', iecLocation: '' },
      { ...first, channelId: 'second', subIndex: 2, iecLocation: '%QB1' },
    ]
    const config = configWith({ ...node, rpdos: [rpdo] })
    const dbc = buildDbc(config, { networkName: 'n' })
    const msg = parse(dbc.text).messages.get(rpdo.cobId)
    expect(msg).toMatchObject({ dlc: 3, transmitter: 'PLC' })
    expect(msg?.signals.map((s) => [s.name, s.start])).toEqual([
      ['lamps', 0],
      [expect.stringMatching(/^io2_/), 16],
    ])
    expect(dbc.text).toContain(`BA_ "IecLocation" SG_ ${rpdo.cobId} lamps "${first.iecLocation}";`)
  })

  it('writes named bits as 1-bit signals in place of the whole object', () => {
    const node = withInfo(genericNode(2), 0x6000, 1, {
      bits: [
        { value: '0', label: 'Start button' },
        { value: '1', label: 'Door closed' },
      ],
    })
    const tpdo = node.tpdos.find((p) => p.entries.some((e) => e.index === 0x6000))
    if (!tpdo) throw new Error('fixture has no 0x6000 mapping')
    const dbc = buildDbc(configWith(node), { networkName: 'n' })
    const names = parse(dbc.text)
      .messages.get(tpdo.cobId)
      ?.signals.map((s) => [s.name, s.length])
    expect(names).toEqual(
      expect.arrayContaining([
        [expect.stringMatching(/Start_button$/), 1],
        [expect.stringMatching(/Door_closed$/), 1],
      ]),
    )
    const whole = parse(dbc.text)
      .messages.get(tpdo.cobId)
      ?.signals.filter((s) => s.length === 8 && s.start === 0)
    expect(whole).toEqual([])
  })

  it('writes REAL32 as a float signal', () => {
    const node = genericNode(2)
    const tpdo = { ...node.tpdos[0], entries: [{ ...node.tpdos[0].entries[0], dataType: 'REAL32' as const }] }
    const dbc = buildDbc(configWith({ ...node, tpdos: [tpdo] }), { networkName: 'n' })
    expect(dbc.text).toMatch(new RegExp(`SIG_VALTYPE_ ${tpdo.cobId} \\w+ : 1;`))
    const values = decode(dbc.text, tpdo.cobId, '00 00 48 41')
    expect(Object.values(values)).toContain(12.5)
  })

  it('gives event timer and inhibit time as cycle and delay', () => {
    const node = genericNode(2)
    const tpdo = { ...node.tpdos[0], eventTimerMs: 50, inhibitTime: 100 }
    const dbc = buildDbc(configWith({ ...node, tpdos: [tpdo] }), { networkName: 'n' })
    expect(dbc.text).toContain(`BA_ "GenMsgCycleTime" BO_ ${tpdo.cobId} 50;`)
    expect(dbc.text).toContain(`BA_ "GenMsgDelayTime" BO_ ${tpdo.cobId} 10;`)
  })
})

describe('DBC export: network frames', () => {
  it('decodes NMT, heartbeat and EMCY', () => {
    const dbc = buildDbc(network(), { networkName: 'canopen1' })
    expect(decode(dbc.text, 0x000, '01 02')).toEqual({ NMT_Command: 'Start', NMT_NodeId: 2 })
    expect(decode(dbc.text, 0x702, '05')).toMatchObject({ io2_NmtState: 'Operational', io2_Toggle: 0 })
    const emcy = decode(dbc.text, 0x82, '30 81 11 00 00 00 00 00')
    expect(emcy).toMatchObject({
      io2_EmcyCode: 'Life guard or heartbeat error',
      io2_ER_Generic_error: 1,
      io2_ER_Communication_error: 1,
    })
  })

  it('writes SYNC with its period and leaves TIME out when the network has none', () => {
    const config = network()
    const dbc = buildDbc(
      { ...config, network: { ...config.network, syncMode: 'period', syncPeriodUs: 10000 } },
      { networkName: 'n' },
    )
    expect(dbc.text).toContain('BO_ 128 SYNC: 0 PLC')
    expect(dbc.text).toContain('BA_ "GenMsgCycleTime" BO_ 128 10;')
    expect(dbc.text).not.toMatch(/BO_ \d+ TIME:/)
  })

  it('names the master and the nodes and gives the bit rate', () => {
    const dbc = buildDbc(network(), { networkName: 'canopen1' })
    expect(dbc.text).toContain('BU_: PLC io2 ai3')
    expect(dbc.text).toContain('BA_ "CANopenNodeId" BU_ io2 2;')
    expect(dbc.text).toContain(`BA_ "Baudrate" ${network().network.bitrate};`)
    expect(dbc.fileName).toBe('canopen1.dbc')
  })
})

describe('DBC export: SDO', () => {
  const dbc = buildDbc(configWith(genericNode(2)), { networkName: 'n' }).text

  it('decodes an expedited write with its typed value', () => {
    const v = decode(dbc, 0x602, '2B 17 10 00 64 00 00 00')
    expect(v.io2_SDO_Rx_Cmd).toBe('expedited download')
    const name = /CM_ SG_ 1538 (\w+) "0x1017:0 /.exec(dbc)?.[1] ?? ''
    expect(v[name]).toBe(100)
  })

  it('decodes an abort with the object name and the abort text', () => {
    const v = decode(dbc, 0x582, '80 01 64 01 02 00 01 06')
    expect(v.io2_SDO_Tx_AbortObject).toMatch(/^0x6401:1 /)
    expect(v.io2_SDO_Tx_AbortCode).toBe('Attempt to write a read only object')
  })

  it('decodes an object the device file does not describe as raw data', () => {
    const v = decode(dbc, 0x582, '4B 00 50 00 2A 00 00 00')
    expect(v.io2_R_Data).toBe(42)
  })

  it('decodes a segmented read', () => {
    expect(decode(dbc, 0x582, '41 08 10 00 0B 00 00 00')).toMatchObject({
      io2_SDO_Tx_SegObject: expect.stringMatching(/^0x1008:0 /),
      io2_SDO_Tx_SegSize: 11,
    })
    expect(decode(dbc, 0x582, '00 47 65 6E 65 72 69 63').io2_SDO_Tx_SegData).toBeDefined()
  })

  it('decodes every command byte in both directions', () => {
    for (const id of [0x602, 0x582])
      for (let c = 0; c < 256; c++)
        for (const obj of ['17 10 00', '00 50 00', '00 10 07'])
          expect(() => decode(dbc, id, `${c.toString(16).padStart(2, '0')} ${obj} 01 02 03 04`)).not.toThrow()
  })

  it('decodes fewer objects with configured SDO values', () => {
    const config = configWith(genericNode(2))
    const all = buildDbc(config, { networkName: 'n' }).text.length
    const some = buildDbc(withDbcExportOptions(config, { ...defaultDbcExportOptions(), sdoValues: 'configured' }), {
      networkName: 'n',
    }).text
    expect(some.length).toBeLessThan(all)
    expect(() => decode(some, 0x582, '43 00 10 00 01 02 03 04')).not.toThrow()
  })
})

describe('DBC export: names and check', () => {
  it('cuts long names to 32 characters and keeps them unique', () => {
    const node = { ...genericNode(2), name: 'a_very_long_node_name_for_this_network' }
    const dbc = buildDbc(configWith(node), { networkName: 'n' })
    const names = [...parse(dbc.text).messages.values()].flatMap((m) => [m.name, ...m.signals.map((s) => s.name)])
    expect(names.every((n) => n.length <= 32)).toBe(true)
    expect(new Set(names.map((n) => n.toLowerCase())).size).toBe(names.length)
    expect(dbc.text).toContain('BA_ "SystemNodeLongSymbol" BU_')
  })

  it('refuses two messages on one COB-ID', () => {
    const a = genericNode(2)
    const b = genericNode(3)
    const clash = { ...b, tpdos: b.tpdos.map((p, i) => (i === 0 ? { ...p, cobId: a.tpdos[0].cobId } : p)) }
    const dbc = buildDbc(configWith(a, clash), { networkName: 'n' })
    expect(dbc.problems.some((p) => p.message.includes(`0x${a.tpdos[0].cobId.toString(16).toUpperCase()}`))).toBe(true)
  })

  it('writes numbers in their shortest form', () => {
    expect(dbcNumber(3276.7000000000003)).toBe('3276.7')
    expect(dbcNumber(0.1)).toBe('0.1')
    expect(dbcNumber(5)).toBe('5')
  })

  it('makes a file name from the network name', () => {
    expect(dbcNetworkFileName('canopen1')).toBe('canopen1.dbc')
    expect(dbcNetworkFileName('a/b')).toBe('a_b.dbc')
  })
})

describe('DBC export: options and losses', () => {
  it('leaves heartbeats out and lists them as left out', () => {
    const config = withDbcExportOptions(network(), { ...defaultDbcExportOptions(), heartbeat: false })
    const dbc = buildDbc(config, { networkName: 'n' })
    expect(dbc.text).not.toMatch(/_Heartbeat:/)
    expect(dbcOptionLosses(config)).toEqual(['left out above: heartbeat and node guarding frames'])
    expect(exportLosses('dbc', config.nodes, true, config)[0]).toBe(
      'left out above: heartbeat and node guarding frames',
    )
  })

  it('says why a frame type has nothing to export', () => {
    const config = network()
    expect(dbcFrameUnavailable(config, 'time')).toBe('TIME is off in this network')
    expect(dbcFrameUnavailable(config, 'pdo')).toBeNull()
  })

  it('uses the defaults when the project has no options', () => {
    expect(dbcExportOptions(network())).toEqual(defaultDbcExportOptions())
  })

  it('exports a node and the network without stored device files', () => {
    const config = network()
    expect(exportNeedsDeviceFile('dbc')).toBe(false)
    expect(exportFileType('dbc').extensions).toEqual(['dbc'])
    const node = buildNodeExport('dbc', config.nodes[0], '', config, { now: new Date(), networkName: 'n' })
    expect(node.fileName).toBe('node_2.dbc')
    expect(node.text).not.toContain('BO_ 1667 ai3_SDO_Rx')
    const net = buildNetworkExport('dbc', config, { now: new Date(), networkName: 'canopen1' })
    expect(net.missing).toEqual([])
    expect(net.files.map((f) => f.fileName)).toEqual(['canopen1.dbc'])
  })
})
