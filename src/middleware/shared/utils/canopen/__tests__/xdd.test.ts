import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { CanopenConfig, CanopenEdsInfo, CanopenNode, CanopenObject } from '../../../ports/canopen-types'
import { importDcfSettings } from '../dcf-import'
import { buildNetworkExport, buildNodeExport, exportLosses } from '../device-export'
import { prepareDeviceFile, replaceDeviceFile, storedFileText, withStoredFile } from '../device-import'
import { describedObjects, writeEds, writeXdd } from '../device-writer'
import { checkEds } from '../eds-check'
import { readEdsDocument } from '../eds-document'
import { createCanopenNode, defaultCanopenConfig, updatePdo, withEntryAlias } from '../model'
import { describeValue, scaledValue, setBitNames, shortDescription, valueMeaning } from '../object-info'
import { objectInfo, standardInfo } from '../standard-meanings'
import { checkXdd, deviceFindingClause, deviceFindingPlace, deviceFindingTitle, isCia311Finding } from '../xdd-check'
import { stripXdcContent } from '../xdd-export'
import { parseXdd } from '../xdd-parser'
import { GENERIC_IO_EDS, genericIoEds, sequentialAllocator } from './fixtures/helpers'

const DIR = join(__dirname, 'fixtures', 'cia311')
const read = (name: string): string => readFileSync(join(DIR, name), 'utf8')
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text)
const NOW = new Date(2026, 10, 1, 12, 0, 0)
let ids = 0
const newId = (): string => `x${++ids}`

function find(eds: CanopenEdsInfo, index: number, sub = 0): CanopenObject {
  const o = eds.objects.find((x) => x.index === index && x.subIndex === sub)
  if (!o) throw new Error(`0x${index.toString(16)} sub ${sub} missing`)
  return o
}

async function prepare(name: string, text = read(name)) {
  return prepareDeviceFile(name, bytes(text))
}

async function networkFrom(name: string, edit?: (n: CanopenNode) => CanopenNode, text?: string) {
  const prepared = await prepare(name, text)
  if (!prepared.eds) throw new Error(`${name} does not load`)
  let node = createCanopenNode(prepared.eds, {
    id: 'n',
    name: 'io5',
    nodeId: 5,
    newId,
    allocate: sequentialAllocator(),
  })
  if (edit) node = edit(node)
  const base = defaultCanopenConfig()
  const config: CanopenConfig = withStoredFile(
    { ...base, network: { ...base.network, bitrate: 250000 }, nodes: [node] },
    prepared,
  )
  return { config, node, prepared }
}

const comparable = (o: CanopenObject): string =>
  JSON.stringify([
    o.index,
    o.subIndex,
    o.name,
    o.dataType,
    o.access === 'rwr' || o.access === 'rww' ? 'rw' : o.access,
    o.pdoMapping,
    o.defaultValue,
    o.lowLimit,
    o.highLimit,
  ])

describe('XDD reader', () => {
  const full = parseXdd(read('generic-io-module-full.xdd'), 'generic-io-module-full.xdd').eds

  it('reads every object of the self-made file with its CiA 311 information', () => {
    expect(full.objects).toHaveLength(257)
    expect(full.productName).toBe('Generic I/O module')
    expect(full.vendorId).toBe(0xabc)
    expect(full.rxPdoCount).toBe(4)
    expect(full.txPdoCount).toBe(4)
    expect(find(full, 0x2003).info).toMatchObject({ unit: '°C', multiplier: 0.1, min: '-400', max: '1250' })
    expect(find(full, 0x2004).info?.values).toEqual([
      { value: '0', label: 'Switch off' },
      { value: '1', label: 'Hold last value' },
      { value: '2', label: 'Use the substitute value' },
    ])
    expect(find(full, 0x1800, 1).info?.bits).toContainEqual({ value: '0', label: 'CAN-ID', width: 11 })
    expect(find(full, 0x2000).info?.group).toBe('Configuration')
    expect(full.details).toMatchObject({ orderNumber: 'IO-8822-A', languages: ['en', 'de'] })
    expect(full.details?.characteristics).toHaveLength(3)
  })

  it('shows another language when asked and falls back to the first', () => {
    const de = parseXdd(read('generic-io-module-full.xdd'), 'x.xdd', 'de').eds
    expect(find(de, 0x2000).info?.label).toBe('Betriebsart')
    expect(find(de, 0x2003).info?.description).toBe('Temperature inside the housing, in steps of 0.1 °C.')
  })

  it('reads version 1.0 and files without a namespace like version 1.1', () => {
    const v11 = parseXdd(read('generic-io-module.xdd'), 'a.xdd').eds.objects.map(comparable)
    expect(parseXdd(read('version-1-0.xdd'), 'b.xdd').eds.objects.map(comparable)).toEqual(v11)
    expect(parseXdd(read('no-namespace.xdd'), 'c.xdd').eds.objects.map(comparable)).toEqual(v11)
  })

  it('gives the same objects, PDOs and addresses as the EDS of the same module', async () => {
    const fromEds = genericIoEds()
    const fromXdd = (await prepare('generic-io-module.xdd')).eds
    if (!fromXdd) throw new Error('no description')
    expect(fromXdd.objects.map(comparable)).toEqual(fromEds.objects.map(comparable))
    const opts = { id: 'a', name: 'io', nodeId: 1, newId: () => 'c', allocate: sequentialAllocator() }
    const a = createCanopenNode(fromEds, opts)
    const b = createCanopenNode(fromXdd, { ...opts, allocate: sequentialAllocator() })
    expect(b.tpdos).toEqual(a.tpdos)
    expect(b.rpdos).toEqual(a.rpdos)
  })
})

interface Expected {
  ok: boolean
  /** Whether the file passes the CiA 311 v1.1 schema (checked in CI). */
  schemaValid: boolean
  findings: string[]
}

describe('CiA 311 check', () => {
  const expected = JSON.parse(read('expected.json')) as Record<string, Expected>

  it('has an expected verdict for every fixture', () => {
    const files = readdirSync(DIR).filter((f) => /\.xd[dc]$/.test(f))
    expect(Object.keys(expected).sort()).toEqual(files.sort())
  })

  it.each(Object.keys(expected))('%s', (name) => {
    const text = read(name)
    let eds: CanopenEdsInfo | undefined
    try {
      eds = parseXdd(text, name).eds
    } catch {
      eds = undefined
    }
    const result = checkXdd(text, eds)
    expect(result.ok).toBe(expected[name].ok)
    expect(
      result.findings.map((f) => `${f.severity} ${f.rule} ${isCia311Finding(f) ? (f.element ?? '') : ''}`.trim()),
    ).toEqual(expected[name].findings)
  })

  it('names the object, both types and the rule', () => {
    const f = checkXdd(read('type-mismatch.xdd')).findings[0]
    expect(f.message).toBe("dataType 0003 (INTEGER16) does not agree with its parameter's UDINT")
    expect(deviceFindingPlace(f)).toMatch(/^0x6401 sub 1 line \d+$/)
    expect(deviceFindingTitle(f)).toBe("An object's data type code agrees with its parameter's type")
    expect(deviceFindingClause(f)).toBe('CiA 311')
  })

  it('blocks a communication object with a wrong CiA 301 type, and only that', () => {
    const broken = read('generic-io-module.xdd').replace(
      /(<CANopenObject index="1A00"[\s\S]*?subIndex="00"[^>]*dataType=")0005/,
      '$10007',
    )
    const result = checkXdd(broken, parseXdd(broken, 'b.xdd').eds)
    expect(result.ok).toBe(false)
    expect(result.findings.filter((f) => f.severity === 'error').map((f) => f.rule)).toEqual(['comm-data-type'])
  })

  it('refuses broken XML and names its line', async () => {
    const prepared = await prepare('broken.xdd', read('generic-io-module.xdd').replace('</c:DeviceIdentity>', ''))
    expect(prepared.eds).toBeUndefined()
    expect(prepared.check.findings[0]).toMatchObject({ rule: 'xml-syntax', severity: 'error' })
    expect(deviceFindingPlace(prepared.check.findings[0])).toMatch(/^line \d+$/)
  })

  it('refuses an XDD of another fieldbus', async () => {
    const prepared = await prepare('other-fieldbus.xdd')
    expect(prepared.eds).toBeUndefined()
    expect(prepared.check.findings[0].message).toBe('the file is not a CANopen XDD or XDC (CiA 311)')
  })
})

describe('XDC settings', () => {
  const at250 = (): CanopenConfig => {
    const config = defaultCanopenConfig()
    return { ...config, network: { ...config.network, bitrate: 250000 } }
  }

  async function importXdc(name: string, config: CanopenConfig = at250()) {
    const prepared = await prepare(name)
    if (!prepared.eds) throw new Error('does not load')
    return {
      prepared,
      ...importDcfSettings(prepared.eds, prepared.dcf, config, { id: 'new', newId, allocate: sequentialAllocator() }),
    }
  }

  it('takes node ID, heartbeat and alias, and refuses a restricted EMCY CAN-ID', async () => {
    const { node, prepared, warnings, notTaken } = await importXdc('settings.xdc')
    expect(prepared.hasSettings).toBe(true)
    expect(node.nodeId).toBe(5)
    expect(node.name).toBe('tank_io')
    expect(node.heartbeatProducerMs).toBe(100)
    expect(node.tpdos.flatMap((p) => p.entries).find((e) => e.index === 0x6401 && e.subIndex === 1)?.alias).toBe(
      'tank_level',
    )
    expect(warnings.some((w) => /kbit/.test(w))).toBe(false)
    expect(notTaken).toContainEqual({
      what: 'Emergency',
      detail: 'COB-ID 0x1 is a restricted CAN-ID (CiA 301); the device default is kept',
    })
  })

  it('treats node ID 0 as not set and reads a bare bit rate as kbit/s', async () => {
    const { node, warnings } = await importXdc('no-node-id.xdc')
    expect(node.nodeId).toBe(1)
    expect(warnings.some((w) => w.includes('125'))).toBe(true)
  })
})

describe('object information', () => {
  const full = parseXdd(read('generic-io-module-full.xdd'), 'f.xdd').eds
  const eds = genericIoEds()

  it('gives meanings, scaled values, bits and fields from the file', () => {
    expect(valueMeaning(find(full, 0x1800, 2), '254')).toBe('Event-driven, manufacturer-specific')
    expect(scaledValue(find(full, 0x2003), '412')).toBe('41.2 °C')
    expect(setBitNames(find(full, 0x1800, 1), String(0x40000185))).toEqual(['CAN-ID=0x185', 'No RTR allowed'])
    expect(describeValue(find(full, 0x2004), '1')).toBe('1 (Hold last value)')
  })

  it('folds a description written as a list into one line', () => {
    const o: CanopenObject = { ...find(eds, 0x2100), info: { description: 'Modes:\n* off\n* on' } }
    expect(shortDescription(o)).toBe('Modes: off; on')
  })

  it("uses the standard's meaning where the file says nothing, marked as such", () => {
    const o = find(eds, 0x1001)
    expect(setBitNames(o, '17')).toEqual(['Generic error', 'Communication error'])
    expect(objectInfo(o)?.standard).toBe('CiA 301')
    expect(valueMeaning(find(eds, 0x1800, 2), '5')).toBe('Synchronous, every 5 SYNCs')
    expect(objectInfo(find(eds, 0x6000, 1))?.bits?.[0]).toEqual({ value: '0', label: 'Input 1' })
    expect(standardInfo(0x2100, 0)).toBeUndefined()
  })

  it("keeps the file's own information over the standard's", () => {
    const o: CanopenObject = { ...find(eds, 0x1001), info: { bits: [{ value: '0', label: 'Any fault' }] } }
    expect(setBitNames(o, '17')).toEqual(['Any fault'])
    expect(objectInfo(o)?.bits).toEqual([{ value: '0', label: 'Any fault' }])
  })
})

describe('XDD and XDC export', () => {
  it('writes an XDD from an EDS that reads back with every object', async () => {
    const { config, node } = await networkFrom('generic-io-module.eds', undefined, GENERIC_IO_EDS)
    const file = buildNodeExport('xdd', node, storedFileText(config, node) ?? '', config, { now: NOW })
    expect(file.fileName).toBe('generic-io-module.xdd')
    expect(file.errors).toEqual([])
    expect(parseXdd(file.text, file.fileName).eds.objects.map(comparable)).toEqual(node.eds.objects.map(comparable))
    expect(file.text).toBe(read('generic-io-module.xdd'))
    expect(exportLosses('xdd', [node], false)).toContain('the comments of the EDS, ObjFlags and CompactPDO hints')
  })

  it('gives a stored XDD back unchanged and an XDC without its values', async () => {
    const xdd = await networkFrom('generic-io-module-full.xdd')
    const same = buildNodeExport('xdd', xdd.node, storedFileText(xdd.config, xdd.node) ?? '', xdd.config, {
      now: NOW,
    })
    expect(same.text).toBe(read('generic-io-module-full.xdd'))
    const xdc = await networkFrom('generic-io-module-full.xdc')
    const stripped = buildNodeExport('xdd', xdc.node, storedFileText(xdc.config, xdc.node) ?? '', xdc.config, {
      now: NOW,
    })
    expect(stripped.fileName).toBe('generic-io-module-full.xdd')
    expect(stripped.text).not.toMatch(/actualValue|denotation=|deviceCommissioning/)
    expect(stripped.errors).toEqual([])
    expect(stripXdcContent('<CANopenObject index="1017" actualValue="5" denotation="x"/>')).toBe(
      '<CANopenObject index="1017"/>',
    )
  })

  it('writes the XDC values, aliases and commissioning, and reads them back the same', async () => {
    const { config, node } = await networkFrom('generic-io-module.xdd', (n) => {
      const entry = n.tpdos.flatMap((p) => p.entries).find((e) => e.index === 0x6401 && e.subIndex === 1)
      return { ...withEntryAlias(n, entry?.channelId ?? '', 'tank_level'), heartbeatProducerMs: 100 }
    })
    const file = buildNodeExport('xdc', node, storedFileText(config, node) ?? '', config, {
      now: NOW,
      networkName: 'line_1',
    })
    expect(file.fileName).toBe('node_5.xdc')
    expect(file.errors).toEqual([])
    expect(file.problems).toEqual([])
    expect(file.text).toMatch(/<CANopenObject index="1017"[^>]*actualValue="100"/)
    expect(file.text).toMatch(/<CANopenSubObject subIndex="01"[^>]*name="Input 1"[^>]*denotation="tank_level"/)
    expect(file.text).toMatch(/<deviceCommissioning nodeID="5" nodeName="io5" actualBaudRate="250 Kbps"/)
    const back = await prepare(file.fileName, file.text)
    if (!back.eds) throw new Error('export does not read back')
    const { node: again } = importDcfSettings(back.eds, back.dcf, defaultCanopenConfig(), {
      id: 'b',
      newId,
      allocate: sequentialAllocator(),
    })
    expect(again.nodeId).toBe(5)
    expect(again.heartbeatProducerMs).toBe(100)
    const mapping = (n: CanopenNode): string[] =>
      [...n.tpdos, ...n.rpdos].flatMap((p) =>
        p.entries.map((e) => `${p.number}:${e.index}:${e.subIndex}:${e.alias ?? ''}`),
      )
    expect(mapping(again)).toEqual(mapping(node))
  })

  it('writes a DCF and an EDS of an XDD node that pass the CiA 306 check and lists what they lose', async () => {
    const { config, node } = await networkFrom('generic-io-module-full.xdd', (n) =>
      updatePdo(n, 'input', 1, (p) => ({ ...p, eventTimerMs: 50 })),
    )
    const stored = storedFileText(config, node) ?? ''
    const dcf = buildNodeExport('dcf', node, stored, config, { now: NOW })
    expect(dcf.errors).toEqual([])
    expect(dcf.problems).toEqual([])
    expect(checkEds(readEdsDocument(dcf.text), { format: 'dcf' }).ok).toBe(true)
    expect(dcf.text).toMatch(/LastEDS=generic-io-module-full\.eds/)
    const eds = buildNodeExport('eds', node, stored, config, { now: NOW })
    expect(eds.fileName).toBe('generic-io-module-full.eds')
    expect(checkEds(readEdsDocument(eds.text)).ok).toBe(true)
    for (const format of ['dcf', 'eds'] as const)
      expect(exportLosses(format, [node], false).some((l) => l.startsWith('what only an XDD holds'))).toBe(true)
  })

  it('exports one XDD per stored file and one XDC per node for the network', async () => {
    const { config, node } = await networkFrom('generic-io-module.xdd')
    const two = { ...config, nodes: [node, { ...node, id: 'm', nodeId: 6, name: 'io6' }] }
    expect(buildNetworkExport('xdd', two, { now: NOW }).files.map((f) => f.fileName)).toEqual(['generic-io-module.xdd'])
    expect(buildNetworkExport('xdc', two, { now: NOW }).files.map((f) => f.fileName)).toEqual([
      'node_5.xdc',
      'node_6.xdc',
    ])
    expect(exportLosses('xdd', two.nodes, true)).toContain(
      'which nodes use each file: nodes that share a device file share one XDD',
    )
  })

  it('writes EDS and XDD files that read back the same description', () => {
    const eds = genericIoEds()
    const xdd = parseXdd(writeXdd(eds, { fileName: 'a.xdd', now: NOW }), 'a.xdd').eds
    const back = writeEds(xdd, { fileName: 'b.eds', now: NOW })
    expect(checkEds(readEdsDocument(back)).ok).toBe(true)
    expect(describedObjects(eds).find((o) => o.index === 0x1018)?.objectType).toBe(8)
  })
})

describe('replacing an EDS by the XDD of the same device', () => {
  it('keeps PDOs, addresses and startup SDOs and drops nothing', async () => {
    const { node } = await networkFrom(
      'generic-io-module.eds',
      (n) => ({
        ...n,
        sdos: [{ id: 's', index: 0x2100, subIndex: 0, dataType: 'UNSIGNED32', value: '7' }],
      }),
      GENERIC_IO_EDS,
    )
    const xdd = (await prepare('generic-io-module.xdd')).eds
    if (!xdd) throw new Error('no description')
    const { node: replaced, dropped } = replaceDeviceFile(node, xdd, newId, sequentialAllocator())
    expect(dropped).toEqual([])
    expect(replaced.tpdos).toEqual(node.tpdos)
    expect(replaced.sdos).toEqual(node.sdos)
  })
})
