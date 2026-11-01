import type { CanopenConfig, CanopenNode } from '../../../ports/canopen-types'
import {
  buildNetworkDcfs,
  buildNetworkExport,
  buildNodeDcf,
  buildNodeExport,
  dcfExportOk,
  deviceFileZip,
  edsFileName,
  exportLosses,
  parameterValueText,
} from '../dcf-export'
import { importDcfSettings, readDcfContent } from '../dcf-import'
import {
  prepareDeviceFile,
  pruneStoredFiles,
  replaceDeviceFile,
  storedFileText,
  withStoredFile,
} from '../device-import'
import { startupSdoCandidates } from '../editing'
import { readEdsDocument } from '../eds-document'
import { parseEds } from '../eds-parser'
import { nodeConfigurationSdos } from '../generate-canopen-config'
import { createCanopenNode, defaultCanopenConfig, updatePdo, withEntryAlias } from '../model'
import { GENERIC_IO_EDS, sequentialAllocator } from './fixtures/helpers'

const NOW = new Date(2026, 9, 31, 14, 5)

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

let ids = 0
const newId = (): string => `id${++ids}`

/** A network with node 2 from the generic I/O module EDS, its file stored. */
async function network(edit?: (node: CanopenNode) => CanopenNode, text = GENERIC_IO_EDS): Promise<CanopenConfig> {
  const prepared = await prepareDeviceFile('generic-io-module.eds', bytes(text))
  if (!prepared.eds) throw new Error('fixture does not load')
  let node = createCanopenNode(prepared.eds, {
    id: 'n2',
    name: 'io2',
    nodeId: 2,
    newId,
    allocate: sequentialAllocator(),
  })
  if (edit) node = edit(node)
  return withStoredFile({ ...defaultCanopenConfig(), nodes: [node] }, prepared)
}

function exportNode(config: CanopenConfig, index = 0): ReturnType<typeof buildNodeDcf> {
  const node = config.nodes[index]
  return buildNodeDcf(node, storedFileText(config, node) ?? '', config, { now: NOW })
}

function sectionOf(text: string, name: string): string {
  const lines = text.split(/\r?\n/)
  const start = lines.indexOf(`[${name}]`)
  if (start < 0) return ''
  const end = lines.findIndex((l, i) => i > start && l.startsWith('['))
  return lines.slice(start, end < 0 ? undefined : end).join('\n')
}

const withTimerAndSdo = (n: CanopenNode): CanopenNode => ({
  ...updatePdo(n, 'input', 1, (p) => ({ ...p, eventTimerMs: 100 })),
  sdos: [{ id: 's1', index: 0x2100, subIndex: 0, dataType: 'UNSIGNED32', value: '1' }],
})

describe('device file store', () => {
  it('stores a file once and drops files no node uses', async () => {
    const config = await network()
    const hash = config.nodes[0].eds.source?.sha256 ?? ''
    expect(Object.keys(config.files ?? {})).toEqual([hash])
    const second = { ...config.nodes[0], id: 'n3', nodeId: 3, name: 'io3' }
    const twice = withStoredFile(
      { ...config, nodes: [...config.nodes, second] },
      { source: second.eds.source ?? { format: 'eds', fileName: '', sha256: '' }, text: GENERIC_IO_EDS },
    )
    expect(Object.keys(twice.files ?? {})).toEqual([hash])
    expect(pruneStoredFiles({ ...twice, nodes: [] }).files).toBeUndefined()
  })

  it('refuses a file whose communication objects are broken', async () => {
    const broken = GENERIC_IO_EDS.replace(
      '[1A00sub0]\nParameterName=Number of mapped objects\nObjectType=0x7\nDataType=0x0005',
      '[1A00sub0]\nParameterName=Number of mapped objects\nObjectType=0x7\nDataType=0x0007',
    )
    const prepared = await prepareDeviceFile('broken.eds', bytes(broken))
    expect(prepared.eds).toBeUndefined()
    expect(prepared.check.findings.find((f) => f.severity === 'error')).toMatchObject({
      rule: 'comm-data-type',
      section: '1A00sub0',
    })
  })
})

describe('DCF export', () => {
  it('writes the values the build writes and leaves every other section as in the EDS', async () => {
    const config = await network(withTimerAndSdo)
    const dcf = exportNode(config)
    expect(dcf.fileName).toBe('node_2.dcf')
    expect(dcfExportOk([dcf])).toBe(true)
    expect(sectionOf(dcf.text, '1800sub5')).toMatch(/\nParameterValue=100(\n|$)/)
    expect(sectionOf(dcf.text, '2100')).toMatch(/\nParameterValue=1(\n|$)/)
    expect(sectionOf(dcf.text, 'DeviceComissioning')).toBe(
      '[DeviceComissioning]\nNodeID=2\nNodeName=io2\nBaudrate=500\nNetNumber=1\nNetworkName=OpenPLC CANopen\nCANopenManager=0\n',
    )
    for (const name of ['6000sub1', '6401sub1', '2200', '1018sub1']) {
      expect(sectionOf(dcf.text, name)).toBe(sectionOf(GENERIC_IO_EDS, name))
    }
    expect(sectionOf(dcf.text, 'FileInfo')).toMatch(/FileName=node_2\.dcf/)
    expect(sectionOf(dcf.text, 'FileInfo')).toMatch(/LastEDS=generic-io-module\.eds/)
    expect(sectionOf(dcf.text, 'FileInfo')).toMatch(/ModificationDate=10-31-2026\nModificationTime=02:05PM/)
  })

  it('keeps the vendor text: only added or changed lines differ from the EDS', async () => {
    const dcf = exportNode(await network(withTimerAndSdo))
    const eds = GENERIC_IO_EDS.split('\n').filter((l) => l !== '' && !l.startsWith('FileName='))
    const kept = dcf.text
      .split('\n')
      .filter((l) => l !== '' && !l.startsWith('; DCF:'))
      .filter(
        (l) => !/^(ParameterValue|Denotation|FileName|LastEDS|ModifiedBy|ModificationDate|ModificationTime)=/.test(l),
      )
    const commissioning = kept.indexOf('[DeviceComissioning]')
    expect(kept.slice(0, commissioning)).toEqual(eds)
  })

  it('lists a restore step as a comment, never as a value', async () => {
    const config = await network((n) => ({ ...n, restoreDefaults: 1 }))
    const restoring = {
      ...config,
      nodes: [
        {
          ...config.nodes[0],
          eds: {
            ...config.nodes[0].eds,
            objects: [
              ...config.nodes[0].eds.objects,
              {
                index: 0x1011,
                subIndex: 1,
                name: 'Restore all',
                dataType: 'UNSIGNED32',
                access: 'rw' as const,
                pdoMapping: false,
              },
            ],
          },
        },
      ],
    }
    const dcf = exportNode(restoring)
    expect(dcf.text).not.toMatch(/\[1011/)
    expect(dcf.text.split('\n').slice(0, 3).join('\n')).toMatch(/restore all parameters \(0x1011 sub 1\)/)
  })

  it('writes aliases as Denotation and compact arrays into a Value list', async () => {
    const config = await network((n) => {
      const entry = n.tpdos[0].entries[0]
      return withEntryAlias(n, entry.channelId, 'door_open')
    })
    const dcf = exportNode(config)
    expect(sectionOf(dcf.text, '6000sub1')).toMatch(/\nDenotation=door_open/)
    expect(
      parameterValueText(
        { index: 0x2000, subIndex: 1, name: '', dataType: 'INTEGER16', access: 'rw', pdoMapping: false },
        'FEFF',
      ),
    ).toBe('-2')
    expect(
      parameterValueText(
        { index: 0x2000, subIndex: 1, name: '', dataType: 'REAL32', access: 'rw', pdoMapping: false },
        '0000C03F',
      ),
    ).toBe('1.5')
    expect(
      parameterValueText(
        { index: 0x1800, subIndex: 1, name: '', dataType: 'UNSIGNED32', access: 'rw', pdoMapping: false },
        '82010000',
      ),
    ).toBe('0x00000182')
  })

  it.each([
    ['BOOLEAN', '01', '1'],
    ['BOOLEAN', '00', '0'],
    ['INTEGER8', 'FF', '-1'],
    ['UNSIGNED64', '0100000000000000', '1'],
    ['UNSIGNED32', '07000000', '7'],
    ['REAL64', '000000000000F83F', '1.5'],
    ['REAL32', '0000', null],
    ['VISIBLE_STRING', '41', null],
    ['0x0099', '02000000', null],
  ])('writes %s bytes %s as %s', (dataType, hex, text) => {
    expect(
      parameterValueText({ index: 0x2000, subIndex: 0, name: '', dataType, access: 'rw', pdoMapping: false }, hex),
    ).toBe(text)
  })

  it('reports values the file cannot hold instead of writing them', async () => {
    const config = await network((n) => ({
      ...n,
      sdos: [{ id: 'x', index: 0x2999, subIndex: 0, dataType: 'UNSIGNED8', value: '1' }],
    }))
    const dcf = exportNode(config)
    expect(dcf.problems).toEqual([
      { message: '0x2999 sub 0: the build writes it, but the device file does not describe it' },
    ])
    expect(dcfExportOk([dcf])).toBe(false)
  })

  it('refuses a node name that is not printable ASCII and saves nothing', async () => {
    const config = await network((n) => ({ ...n, nodeId: 9, name: 'pump ä' }))
    const { files } = buildNetworkDcfs(config, { now: NOW })
    expect(dcfExportOk(files)).toBe(false)
    expect(files[0].errors).toContainEqual(
      expect.objectContaining({
        section: 'DeviceComissioning',
        key: 'NodeName',
        rule: 'commissioning',
        severity: 'error',
      }),
    )
  })

  it('refuses a bit rate the file marks unsupported', async () => {
    const text = GENERIC_IO_EDS.replace('BaudRate_1000=1', 'BaudRate_1000=0')
    const config = await network(undefined, text)
    const fast = { ...config, network: { ...config.network, bitrate: 1000000 } }
    const [file] = buildNetworkDcfs(fast, { now: NOW }).files
    expect(file.errors).toContainEqual(
      expect.objectContaining({ section: 'DeviceComissioning', key: 'Baudrate', rule: 'commissioning-baudrate' }),
    )
  })

  it('names nodes that have no stored file', async () => {
    const config = await network()
    const bare = { ...config.nodes[0], eds: { ...config.nodes[0].eds, source: undefined } }
    expect(buildNetworkDcfs({ ...config, nodes: [bare] }, { now: NOW }).missing).toEqual([bare])
  })

  it('does not refuse a file for [FileInfo] keys it never had', async () => {
    const bare = GENERIC_IO_EDS.replace(/\[FileInfo\][\s\S]*?(?=\[DeviceInfo\])/, '')
    const dcf = exportNode(await network(undefined, bare))
    expect(dcf.errors).toEqual([])
    expect(sectionOf(dcf.text, 'FileInfo')).toMatch(/FileName=node_2\.dcf/)
  })

  it('writes the sections of PDOs that CompactPDO implies', async () => {
    const compact = GENERIC_IO_EDS.replace('NrOfTXPDO=1', 'NrOfTXPDO=2\nCompactPDO=0x13')
    const config = await network(
      (n) => updatePdo(n, 'input', 2, (p) => ({ ...p, enabled: true, entries: n.tpdos[0].entries })),
      compact,
    )
    expect(config.nodes[0].tpdos.map((p) => p.number)).toEqual([1, 2])
    const dcf = exportNode(config)
    expect(dcfExportOk([dcf])).toBe(true)
    expect(sectionOf(dcf.text, '1801sub1')).toMatch(/ParameterValue=0x40000282/)
    expect(sectionOf(dcf.text, '1A01sub0')).toMatch(/ParameterValue=2/)
  })
})

describe('EDS export', () => {
  it('gives the stored EDS back byte for byte', async () => {
    const config = await network(withTimerAndSdo)
    const node = config.nodes[0]
    const file = buildNodeExport('eds', node, storedFileText(config, node) ?? '', config, { now: NOW })
    expect(file).toMatchObject({ fileName: 'generic-io-module.eds', text: GENERIC_IO_EDS, errors: [], problems: [] })
  })

  it('strips the values of a stored DCF and keeps a clean description', async () => {
    const config = await network(withTimerAndSdo)
    const dcf = exportNode(config).text
    const prepared = await prepareDeviceFile('node_2.dcf', bytes(dcf))
    if (!prepared.eds) throw new Error('export does not load')
    const node = createCanopenNode(prepared.eds, {
      id: 'd',
      name: 'd',
      nodeId: 2,
      newId,
      allocate: sequentialAllocator(),
    })
    const fromDcf = withStoredFile({ ...defaultCanopenConfig(), nodes: [node] }, prepared)
    const file = buildNodeExport('eds', node, storedFileText(fromDcf, node) ?? '', fromDcf, { now: NOW })
    expect(file.fileName).toBe('generic-io-module.eds')
    expect(file.errors).toEqual([])
    expect(file.text).not.toMatch(/ParameterValue=|Denotation=|DeviceComissioning|^; DCF:/m)
    expect(sectionOf(file.text, 'FileInfo')).toContain('FileName=generic-io-module.eds')
    const again = await prepareDeviceFile(file.fileName, bytes(file.text))
    expect(again.check.ok).toBe(true)
  })

  it('names the EDS of a DCF without LastEDS after the DCF', async () => {
    const config = await network()
    const node = {
      ...config.nodes[0],
      eds: { ...config.nodes[0].eds, source: { format: 'dcf' as const, fileName: 'dir/io.dcf', sha256: 'x' } },
    }
    expect(edsFileName(node, '[FileInfo]\nFileName=io.dcf\n')).toBe('io.eds')
    expect(edsFileName({ ...node, eds: { ...node.eds, source: undefined, fileName: '' } }, '')).toBe('node_2.eds')
  })

  it('exports one EDS per stored file for the network', async () => {
    const config = await network()
    const second = { ...config.nodes[0], id: 'n3', nodeId: 3, name: 'io3' }
    const other = await prepareDeviceFile(
      'generic-io-module.eds',
      bytes(GENERIC_IO_EDS.replace('RevisionNumber=0x00000003', 'RevisionNumber=0x00000004')),
    )
    if (!other.eds) throw new Error('fixture does not load')
    const third = createCanopenNode(other.eds, {
      id: 'n4',
      name: 'io4',
      nodeId: 4,
      newId,
      allocate: sequentialAllocator(),
    })
    const all = withStoredFile({ ...config, nodes: [...config.nodes, second, third] }, other)
    const bare = { ...config.nodes[0], id: 'n5', nodeId: 5, eds: { ...config.nodes[0].eds, source: undefined } }
    const { files, missing } = buildNetworkExport('eds', { ...all, nodes: [...all.nodes, bare] }, { now: NOW })
    expect(files.map((f) => f.fileName)).toEqual(['generic-io-module.eds', 'generic-io-module_2.eds'])
    expect(missing).toEqual([bare])
    expect(buildNetworkExport('dcf', all, { now: NOW }).files.map((f) => f.fileName)).toEqual([
      'node_2.dcf',
      'node_3.dcf',
      'node_4.dcf',
    ])
  })
})

describe('DCF import', () => {
  async function importText(text: string, config: CanopenConfig = defaultCanopenConfig()) {
    const prepared = await prepareDeviceFile('io.dcf', bytes(text))
    if (!prepared.eds) throw new Error(prepared.check.findings.map((f) => f.message).join('; '))
    return {
      prepared,
      ...importDcfSettings(prepared.eds, prepared.dcf, config, { id: 'new', newId, allocate: sequentialAllocator() }),
    }
  }

  it('takes node ID, event timer and a startup SDO', async () => {
    const config = await network(withTimerAndSdo)
    const moved = { ...config, nodes: [{ ...config.nodes[0], nodeId: 5 }] }
    const text = exportNode(moved).text
    const { node, prepared } = await importText(text)
    expect(prepared.hasSettings).toBe(true)
    expect(node.nodeId).toBe(5)
    expect(node.tpdos[0].eventTimerMs).toBe(100)
    expect(node.sdos).toEqual([expect.objectContaining({ index: 0x2100, subIndex: 0, value: '1' })])
  })

  it('round-trips a node: same settings, startup SDOs and aliases', async () => {
    const config = await network((n) => {
      let node = withTimerAndSdo(n)
      node = withEntryAlias(node, node.tpdos[0].entries[1].channelId, 'level')
      return { ...node, heartbeatProducerMs: 250, emcy: { enabled: false, cobId: 0x82 } }
    })
    const original = config.nodes[0]
    const { node, notTaken } = await importText(exportNode(config).text)
    expect(notTaken).toEqual([])
    const settings = (n: CanopenNode) => ({
      nodeId: n.nodeId,
      name: n.name,
      supervision: n.supervision,
      heartbeatProducerMs: n.heartbeatProducerMs,
      emcy: n.emcy,
      watchMaster: n.watchMaster,
      receiveTime: n.receiveTime,
      sdos: n.sdos.map(({ index, subIndex, dataType, value }) => ({ index, subIndex, dataType, value })),
      pdos: [...n.tpdos, ...n.rpdos].map((p) => ({
        number: p.number,
        cobId: p.cobId,
        enabled: p.enabled,
        transmissionType: p.transmissionType,
        eventTimerMs: p.eventTimerMs,
        inhibitTime: p.inhibitTime,
        entries: p.entries.map((e) => ({ index: e.index, subIndex: e.subIndex, alias: e.alias })),
      })),
    })
    expect(settings(node)).toEqual(settings(original))
    expect(nodeConfigurationSdos(node, config.network)).toEqual(nodeConfigurationSdos(original, config.network))
  })

  it('round-trips a mapping the device fixes, compact or not', async () => {
    const compact = GENERIC_IO_EDS.replace(
      /\[1A00\][\s\S]*?(?=\[2100\])/,
      '[1A00]\nParameterName=TPDO 1 mapping parameter\nObjectType=0x8\nDataType=0x0007\nAccessType=ro\nCompactSubObj=2\n\n[1A00Value]\nNrOfEntries=2\n1=0x60000108\n2=0x64010110\n\n',
    )
    const plain = GENERIC_IO_EDS.replace(/(\[1A00sub[012]\][^[]*AccessType=)rw/g, '$1ro')
    for (const text of [compact, plain]) {
      const { node, prepared } = await importText(text)
      expect(node.tpdos[0].fixedMapping).toBe(true)
      expect(node.tpdos[0].entries.map((e) => e.index)).toEqual([0x6000, 0x6401])
      const config = withStoredFile({ ...defaultCanopenConfig(), nodes: [node] }, prepared)
      const dcf = exportNode(config)
      expect(dcf.errors).toEqual([])
      const again = await importText(dcf.text)
      expect(again.node.tpdos[0].entries.map((e) => e.index)).toEqual([0x6000, 0x6401])
    }
  })

  it('takes guarding and TIME, keeps network settings out and explains values it cannot take', async () => {
    const obj = (index: string, type: string, extra: string): string =>
      `[${index}]\nParameterName=Object ${index}\nObjectType=0x7\nDataType=${type}\nAccessType=rw\n${extra}\n`
    const text = [
      GENERIC_IO_EDS.replace(/(\[1017\][\s\S]*?)\n\n/, '$1\nParameterValue=0\n\n'),
      obj('100C', '0x0006', 'DefaultValue=0\nParameterValue=200'),
      obj('100D', '0x0005', 'DefaultValue=0\nParameterValue=3'),
      obj('1012', '0x0007', 'DefaultValue=0x100\nParameterValue=0x80000100'),
      obj('1007', '0x0007', 'DefaultValue=0\nParameterValue=500'),
      obj('2300', '0x0008', 'DefaultValue=1.5\nParameterValue=2.25'),
      obj('2301', '0x0006', 'ObjFlags=1\nDefaultValue=0\nParameterValue=5'),
      obj('2302', '0x000F', 'ParameterValue=0102'),
      obj('2400', '0xZZ', 'ParameterValue=1'),
      '[DeviceComissioning]\nNodeID=9\nNodeName=io9\nBaudrate=500\nNetNumber=1\nCANopenManager=0\n',
    ].join('\n')
    const { node, taken, notTaken, warnings } = await importText(text)
    expect(node.supervision).toBe('guarding')
    expect(node.guardTimeMs).toBe(200)
    expect(node.lifeTimeFactor).toBe(3)
    expect(node.receiveTime).toBe(true)
    expect(warnings).toContainEqual(expect.stringMatching(/receives TIME on COB-ID 0x100; the network sends no TIME/))
    expect(taken).toContainEqual({ what: '0x2300:00', detail: 'startup SDO 2.25' })
    const notTakenWhat = notTaken.map((l) => l.what)
    expect(notTakenWhat).toEqual(expect.arrayContaining(['0x1007:00', '0x2301:00', '0x2302:00', '0x2400:00']))
  })

  it('takes the lowest free ID when the asked one is in use', async () => {
    const config = await network()
    const { node, warnings } = await importText(exportNode(config).text, config)
    expect(node.nodeId).toBe(1)
    expect(warnings.join(' ')).toMatch(/node ID 2 is in use/)
  })

  it('warns when the master heartbeat is not shorter than the time the node waits for it', async () => {
    const config = await network()
    const text = exportNode(config).text.replace(
      /\[1016sub1\]([\s\S]*?)PDOMapping=0/,
      (all) => `${all}\nParameterValue=0x007F0064`,
    )
    const { node, warnings } = await importText(text)
    expect(node.watchMaster).toEqual(expect.objectContaining({ enabled: true, consumerMs: 100 }))
    expect(warnings).toContainEqual(expect.stringMatching(/^0x1016: the master's heartbeat \(100 ms\) must be shorter/))
  })

  it('lists a heartbeat of a node the network does not have as not taken', async () => {
    const config = await network()
    const text = exportNode(config).text.replace(
      /\[1016sub1\]([\s\S]*?)PDOMapping=0/,
      (all) => `${all}\nParameterValue=0x004000C8`,
    )
    const { notTaken } = await importText(text)
    expect(notTaken).toContainEqual({ what: '0x1016:01', detail: 'watches node 64, which the network does not have' })
  })

  it('warns about another bit rate and leaves the network alone', async () => {
    const config = await network()
    const text = exportNode(config).text.replace('Baudrate=500', 'Baudrate=250')
    const { warnings } = await importText(text)
    expect(warnings.join(' ')).toMatch(/250 kbit\/s and the network runs 500 kbit\/s/)
  })

  it('reads [DeviceCommissioning], the common misspelling, as commissioning', () => {
    const doc = readEdsDocument('[DeviceInfo]\n[DeviceCommissioning]\nNodeID=9\nNodeName=y\n')
    expect(readDcfContent(doc).commissioning).toEqual(expect.objectContaining({ nodeId: 9, nodeName: 'y' }))
  })

  it('reads values, names and commissioning, including compact lists', () => {
    const doc = readEdsDocument(
      '[DeviceInfo]\n[2200Value]\nNrOfEntries=1\n2=7\n[2200Denotation]\nNrOfEntries=1\n1=first\n[DeviceComissioning]\nNodeID=3\nNodeName=x\nBaudrate=125\nCANopenManager=0\n',
    )
    const content = readDcfContent(doc)
    expect(content.values).toEqual([{ index: 0x2200, subIndex: 2, value: '7' }])
    expect(content.denotations.get('0x2200:01')).toBe('first')
    expect(content.commissioning).toEqual({ nodeId: 3, nodeName: 'x', baudrateKbit: 125, canopenManager: false })
  })
})

describe('objects that refuse a write', () => {
  it('are neither offered as startup SDOs nor written by the build', async () => {
    const text = GENERIC_IO_EDS.replace(
      '[2100]\nParameterName=Parameter',
      '[2100]\nObjFlags=0x1\nParameterName=Parameter',
    )
    const config = await network(withTimerAndSdo, text)
    const node = config.nodes[0]
    expect(startupSdoCandidates(node).map((c) => c.object.index)).not.toContain(0x2100)
    expect(nodeConfigurationSdos(node, config.network).some((s) => s.index === 0x2100)).toBe(false)
  })
})

describe('replaceDeviceFile', () => {
  it('keeps PDOs and addresses and lists what the new file no longer allows', async () => {
    const config = await network(withTimerAndSdo)
    const node = config.nodes[0]
    const revision2 = parseEds(
      GENERIC_IO_EDS.replace('RevisionNumber=0x00000003', 'RevisionNumber=0x00000004').replace(
        /\[2100\][\s\S]*?\n\n/,
        '',
      ),
      'io-r2.eds',
    )
    const { node: replaced, dropped } = replaceDeviceFile(node, revision2, newId, sequentialAllocator())
    expect(replaced.eds.revision).toBe(4)
    expect(replaced.tpdos).toEqual(node.tpdos)
    expect(replaced.sdos).toEqual([])
    expect(dropped).toEqual([{ what: '0x2100:00', detail: 'startup SDO 1' }])
  })

  it('drops the settings and entries the new file does not support', async () => {
    const config = await network()
    const base = config.nodes[0]
    const node: CanopenNode = {
      ...base,
      supervision: 'heartbeat',
      watchMaster: { ...base.watchMaster, enabled: true },
      heartbeatConsumers: [{ id: 'hc', producerNodeId: 7, consumerMs: 300 }],
      receiveTime: true,
      restoreDefaults: 1,
      tpdos: [...base.tpdos, { ...base.tpdos[0], number: 2 }],
    }
    const bare = GENERIC_IO_EDS.replace(/\[1016(sub\d)?\][\s\S]*?\n\n/g, '')
      .replace(/\[1017\][\s\S]*?\n\n/, '')
      .replace(/(\[6401sub1\][\s\S]*?)PDOMapping=1/, '$1PDOMapping=0')
    const { node: replaced, dropped } = replaceDeviceFile(
      node,
      parseEds(bare, 'bare.eds'),
      newId,
      sequentialAllocator(),
    )
    expect(replaced.supervision).toBe('none')
    expect(replaced.watchMaster.enabled).toBe(false)
    expect(replaced.heartbeatConsumers).toEqual([])
    expect(replaced.tpdos.map((p) => p.number)).toEqual([1])
    expect(dropped.map((d) => d.what)).toEqual(
      expect.arrayContaining(['0x6401:01', 'TPDO 2', 'Supervision', 'Watch the master', 'Heartbeat consumer']),
    )
  })

  it('drops node guarding when the new file cannot be guarded', async () => {
    const config = await network()
    const node: CanopenNode = { ...config.nodes[0], supervision: 'guarding' }
    const { node: replaced, dropped } = replaceDeviceFile(node, node.eds, newId, sequentialAllocator())
    expect(replaced.supervision).toBe('none')
    expect(dropped).toContainEqual(expect.objectContaining({ what: 'Supervision' }))
  })
})

describe('export losses', () => {
  it('says what each format leaves out', async () => {
    const config = await network((n) => ({
      ...updatePdo(n, 'input', 1, (p) => ({ ...p, receiveTimeoutMs: 50 })),
      restoreDefaults: 1,
    }))
    const node = config.nodes[0]
    const dcf = exportLosses('dcf', [node], false)
    expect(dcf.join('\n')).toMatch(/IEC addresses of \d+ mapped entr/)
    expect(dcf).toContain('receive timeouts on 1 PDO')
    expect(dcf.join('\n')).toContain('0x1011 sub 1')
    expect(dcf.join('\n')).not.toContain('node ID, name')
    const eds = exportLosses('eds', [node], false)
    expect(eds[0]).toContain('node ID, name, PDO settings')
    expect(eds.join('\n')).not.toContain('0x1011')
    expect(exportLosses('dcf', [{ ...node, configure: false }], false).join('\n')).toContain('does not configure')
  })

  it('adds the network settings and shared files for a network', async () => {
    const config = await network()
    const nodes = [config.nodes[0], { ...config.nodes[0], id: 'n3', nodeId: 3 }]
    const eds = exportLosses('eds', nodes, true)
    expect(eds[0]).toContain('bit rate')
    expect(eds[1]).toContain('share one EDS')
    expect(eds.some((l) => l.startsWith('node 3: '))).toBe(true)
    expect(exportLosses('dcf', nodes, true)[0]).toContain('each DCF keeps the bit rate')
  })
})

describe('device file zip', () => {
  it('writes local entry times', async () => {
    const JSZip = (await import('jszip')).default
    const now = new Date(2026, 10, 1, 12, 29)
    const zip = await JSZip.loadAsync(
      await deviceFileZip([{ fileName: 'a.dcf', text: 'x', summary: '', errors: [], problems: [] }], now),
    )
    const entry = zip.file('a.dcf')
    expect(entry?.date.getUTCHours()).toBe(12)
    expect(entry?.date.getUTCMinutes()).toBe(29)
  })
})
