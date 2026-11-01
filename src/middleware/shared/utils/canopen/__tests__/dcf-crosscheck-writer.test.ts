/**
 * Writes the corpus of the CI cross-check (.github/workflows/canopen-dcf-crosscheck.yml): the check
 * fixtures, the generic I/O module and DCFs exported from it, each with the editor's verdict, and in
 * `xdd/` the CiA 311 fixtures with the XDD and XDC files exported from them.
 * Runs only when CANOPEN_DCF_CROSSCHECK_OUT names the output folder.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { CanopenConfig, CanopenNode } from '../../../ports/canopen-types'
import { buildNodeDcf } from '../dcf-export'
import { buildNodeExport } from '../device-export'
import { readDcfContent } from '../dcf-import'
import { decodeDeviceFile, deviceFileFormat } from '../device-file'
import { prepareDeviceFile, storedFileText, withStoredFile } from '../device-import'
import { checkEds } from '../eds-check'
import { readEdsDocument } from '../eds-document'
import { createCanopenNode, defaultCanopenConfig, updatePdo, withEntryAlias } from '../model'
import { GENERIC_IO_EDS, sequentialAllocator } from './fixtures/helpers'

const OUT = process.env.CANOPEN_DCF_CROSSCHECK_OUT
const FIXTURES = join(__dirname, 'fixtures', 'cia306')
const XDD_FIXTURES = join(__dirname, 'fixtures', 'cia311')
const NOW = new Date(2026, 0, 1, 9, 30)

interface Verdict {
  kind: 'eds' | 'export'
  /** For an export: the file it was written from. */
  source?: string
  ok: boolean
  findings: Array<{ rule: string; severity: string; section?: string; key?: string; line?: number; index?: number }>
  /** For an export: the ParameterValues and commissioning the editor reads back, for the round trip. */
  values?: Record<string, string>
  commissioning?: { nodeId?: number; nodeName?: string; baudrateKbit?: number }
}

function verdict(name: string, text: string, kind: Verdict['kind'], source?: string): Verdict {
  const decoded = decodeDeviceFile(new TextEncoder().encode(text))
  const doc = readEdsDocument(decoded.text)
  const format = deviceFileFormat(name)
  const result = checkEds(doc, { encoding: decoded.encoding, format: format === 'dcf' ? 'dcf' : 'eds' })
  const content = kind === 'export' ? readDcfContent(doc) : undefined
  const values = content
    ? Object.fromEntries(
        content.values.map((v) => [
          `0x${v.index.toString(16).toUpperCase().padStart(4, '0')}:${v.subIndex.toString(16).toUpperCase().padStart(2, '0')}`,
          v.value,
        ]),
      )
    : undefined
  return {
    kind,
    ...(source ? { source } : {}),
    ...(values ? { values } : {}),
    ...(content?.commissioning
      ? {
          commissioning: {
            nodeId: content.commissioning.nodeId,
            nodeName: content.commissioning.nodeName,
            baudrateKbit: content.commissioning.baudrateKbit,
          },
        }
      : {}),
    ok: result.ok,
    findings: result.findings.map(({ rule, severity, section, key, line, index }) => ({
      rule,
      severity,
      section,
      key,
      line,
      index,
    })),
  }
}

async function exported(text: string, edit: (n: CanopenNode) => CanopenNode, nodeId: number): Promise<string> {
  const prepared = await prepareDeviceFile('generic-io-module.eds', new TextEncoder().encode(text))
  if (!prepared.eds) throw new Error('fixture does not load')
  let id = 0
  const node = edit(
    createCanopenNode(prepared.eds, {
      id: `n${nodeId}`,
      name: `io${nodeId}`,
      nodeId,
      newId: () => `c${++id}`,
      allocate: sequentialAllocator(),
    }),
  )
  const config: CanopenConfig = withStoredFile({ ...defaultCanopenConfig(), nodes: [node] }, prepared)
  const dcf = buildNodeDcf(node, storedFileText(config, node) ?? '', config, { now: NOW })
  if (dcf.errors.length > 0 || dcf.problems.length > 0) throw new Error(`export of node ${nodeId} fails`)
  return dcf.text
}

const run = OUT ? it : it.skip

describe('DCF cross-check corpus', () => {
  run('writes the files and the editor verdicts', async () => {
    const out = OUT ?? ''
    mkdirSync(out, { recursive: true })
    const verdicts: Record<string, Verdict> = {}
    for (const name of readdirSync(FIXTURES).filter((f) => f.endsWith('.eds'))) {
      const bytes = new Uint8Array(readFileSync(join(FIXTURES, name)))
      writeFileSync(join(out, name), bytes)
      verdicts[name] = verdict(name, decodeDeviceFile(bytes).text, 'eds')
    }
    writeFileSync(join(out, 'generic-io-module.eds'), GENERIC_IO_EDS)
    verdicts['generic-io-module.eds'] = verdict('generic-io-module.eds', GENERIC_IO_EDS, 'eds')

    const compact = GENERIC_IO_EDS.replace('NrOfTXPDO=1', 'NrOfTXPDO=2\nCompactPDO=0x13')
    writeFileSync(join(out, 'compact-pdo.eds'), compact)
    verdicts['compact-pdo.eds'] = verdict('compact-pdo.eds', compact, 'eds')

    const exports: Array<[string, string, string]> = [
      ['node_2.dcf', 'generic-io-module.eds', await exported(GENERIC_IO_EDS, (n) => n, 2)],
      [
        'node_3.dcf',
        'generic-io-module.eds',
        await exported(
          GENERIC_IO_EDS,
          (n) => ({
            ...withEntryAlias(
              updatePdo(n, 'input', 1, (p) => ({ ...p, eventTimerMs: 100, transmissionType: 1 })),
              n.tpdos[0].entries[0].channelId,
              'door_open',
            ),
            heartbeatProducerMs: 250,
            sdos: [{ id: 's', index: 0x2100, subIndex: 0, dataType: 'UNSIGNED32', value: '7' }],
          }),
          3,
        ),
      ],
      [
        'node_4.dcf',
        'compact-pdo.eds',
        await exported(
          compact,
          (n) => updatePdo(n, 'input', 2, (p) => ({ ...p, enabled: true, entries: n.tpdos[0].entries })),
          4,
        ),
      ],
    ]
    for (const [name, source, text] of exports) {
      writeFileSync(join(out, name), text)
      verdicts[name] = verdict(name, text, 'export', source)
    }
    writeFileSync(join(out, 'verdicts.json'), `${JSON.stringify(verdicts, null, 2)}\n`)
    await writeXddCorpus(join(out, 'xdd'))
    expect(Object.keys(verdicts).length).toBeGreaterThan(10)
  })
})

interface XddVerdict {
  kind: 'fixture' | 'export'
  source?: string
  /** Whether the file must pass the CiA 311 v1.1 schema. */
  schemaValid: boolean
  /** XDC: the actual values the editor reads back, by "0xIIII:SS". */
  values?: Record<string, string>
  commissioning?: { nodeId?: number; nodeName?: string; baudrateKbit?: number }
  /** XDD: every object's default value ('' when none), by "0xIIII:SS". */
  objects?: Record<string, string>
}

const ref = (index: number, sub: number): string =>
  `0x${index.toString(16).toUpperCase().padStart(4, '0')}:${sub.toString(16).toUpperCase().padStart(2, '0')}`

async function xddVerdict(
  name: string,
  text: string,
  base: Omit<XddVerdict, 'values' | 'objects'>,
): Promise<XddVerdict> {
  const prepared = await prepareDeviceFile(name, new TextEncoder().encode(text))
  if (!prepared.eds) return base
  if (name.endsWith('.xdc'))
    return {
      ...base,
      values: Object.fromEntries(prepared.dcf.values.map((v) => [ref(v.index, v.subIndex), v.value])),
      commissioning: prepared.dcf.commissioning
        ? {
            nodeId: prepared.dcf.commissioning.nodeId,
            nodeName: prepared.dcf.commissioning.nodeName,
            baudrateKbit: prepared.dcf.commissioning.baudrateKbit,
          }
        : undefined,
    }
  return {
    ...base,
    objects: Object.fromEntries(prepared.eds.objects.map((o) => [ref(o.index, o.subIndex), o.defaultValue ?? ''])),
  }
}

/** The CiA 311 fixtures and the XDD and XDC files exported from them and from the EDS. */
async function writeXddCorpus(out: string): Promise<void> {
  mkdirSync(out, { recursive: true })
  const expected = JSON.parse(readFileSync(join(XDD_FIXTURES, 'expected.json'), 'utf8')) as Record<
    string,
    { schemaValid: boolean }
  >
  const verdicts: Record<string, XddVerdict> = {}
  for (const name of Object.keys(expected)) {
    const text = readFileSync(join(XDD_FIXTURES, name), 'utf8')
    writeFileSync(join(out, name), text)
    verdicts[name] = await xddVerdict(name, text, { kind: 'fixture', schemaValid: expected[name].schemaValid })
  }
  const sources: Array<[string, string, (n: CanopenNode) => CanopenNode]> = [
    ['generic-io-module.eds', GENERIC_IO_EDS, (n) => n],
    [
      'generic-io-module.xdd',
      readFileSync(join(XDD_FIXTURES, 'generic-io-module.xdd'), 'utf8'),
      (n) => ({
        ...withEntryAlias(n, n.tpdos[0].entries[0].channelId, 'tank_level'),
        heartbeatProducerMs: 100,
        sdos: [{ id: 's', index: 0x2100, subIndex: 0, dataType: 'UNSIGNED32', value: '7' }],
      }),
    ],
    ['generic-io-module-full.xdc', readFileSync(join(XDD_FIXTURES, 'generic-io-module-full.xdc'), 'utf8'), (n) => n],
  ]
  let nodeId = 10
  for (const [source, text, edit] of sources) {
    const prepared = await prepareDeviceFile(source, new TextEncoder().encode(text))
    if (!prepared.eds) throw new Error(`${source} does not load`)
    let id = 0
    const node = edit(
      createCanopenNode(prepared.eds, {
        id: `x${nodeId}`,
        name: `io${nodeId}`,
        nodeId: ++nodeId,
        newId: () => `c${++id}`,
        allocate: sequentialAllocator(),
      }),
    )
    const base = defaultCanopenConfig()
    const config = withStoredFile({ ...base, network: { ...base.network, bitrate: 250000 }, nodes: [node] }, prepared)
    for (const format of ['xdd', 'xdc'] as const) {
      const file = buildNodeExport(format, node, storedFileText(config, node) ?? '', config, { now: NOW })
      if (file.errors.length > 0 || file.problems.length > 0) throw new Error(`${format} export of ${source} fails`)
      const name = `${source.replace('.', '-')}-export.${format}`
      writeFileSync(join(out, name), file.text)
      verdicts[name] = await xddVerdict(name, file.text, { kind: 'export', source, schemaValid: true })
    }
  }
  writeFileSync(join(out, 'verdicts.json'), `${JSON.stringify(verdicts, null, 2)}\n`)
}
