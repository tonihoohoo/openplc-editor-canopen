/**
 * Writes the corpus of the CI cross-check (.github/workflows/canopen-dcf-crosscheck.yml): the check
 * fixtures, the generic I/O module and DCFs exported from it, each with the editor's verdict.
 * Runs only when CANOPEN_DCF_CROSSCHECK_OUT names the output folder.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { CanopenConfig, CanopenNode } from '../../../ports/canopen-types'
import { buildNodeDcf } from '../dcf-export'
import { readDcfContent } from '../dcf-import'
import { decodeDeviceFile, deviceFileFormat } from '../device-file'
import { prepareDeviceFile, storedFileText, withStoredFile } from '../device-import'
import { checkEds } from '../eds-check'
import { readEdsDocument } from '../eds-document'
import { createCanopenNode, defaultCanopenConfig, updatePdo, withEntryAlias } from '../model'
import { GENERIC_IO_EDS, sequentialAllocator } from './fixtures/helpers'

const OUT = process.env.CANOPEN_DCF_CROSSCHECK_OUT
const FIXTURES = join(__dirname, 'fixtures', 'cia306')
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
  const result = checkEds(doc, { encoding: decoded.encoding, format: deviceFileFormat(name) })
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
    expect(Object.keys(verdicts).length).toBeGreaterThan(10)
  })
})
