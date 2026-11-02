import { readFileSync } from 'fs'
import { join } from 'path'

import type { CanopenConfig, CanopenNode } from '../../../ports/canopen-types'
import {
  buildNetworkExport,
  buildNodeExport,
  exportFileType,
  exportLosses,
  exportNeedsDeviceFile,
  exportStandard,
} from '../device-export'
import {
  buildHtmlDocument,
  buildHtmlExport,
  canIdRows,
  type HtmlExportInput,
  htmlLosses,
  htmlSections,
  plcVariableUses,
  withHtmlExportOptions,
} from '../html-export'
import { createCanopenNode, defaultCanopenConfig, withEntryAlias } from '../model'
import { parseXdd } from '../xdd-parser'
import { genericNode, sequentialAllocator } from './fixtures/helpers'

const XDD = readFileSync(join(__dirname, 'fixtures', 'cia311', 'generic-io-module-full.xdd'), 'utf8')

function network(): CanopenConfig {
  const allocate = sequentialAllocator()
  const config = defaultCanopenConfig()
  config.network.interface = 'can0'
  config.network.bitrate = 250000
  let n2 = genericNode(2, allocate)
  const firstInput = n2.tpdos[0].entries[0]
  n2 = withEntryAlias(n2, firstInput.channelId, 'tank_level')
  let id = 0
  const n3: CanopenNode = createCanopenNode(parseXdd(XDD, 'generic-io-module-full.xdd').eds, {
    id: 'node-3',
    name: 'io3',
    nodeId: 3,
    newId: () => `x${++id}`,
    allocate,
  })
  config.nodes = [n3, n2]
  return config
}

function input(overrides: Partial<HtmlExportInput> = {}): HtmlExportInput {
  return {
    projectName: 'line',
    networkName: 'canopen1',
    config: network(),
    uses: new Map(),
    sections: htmlSections(undefined),
    editorVersion: '1.0.0',
    now: new Date('2026-11-02T09:30:00Z'),
    ...overrides,
  }
}

describe('htmlSections', () => {
  it('has every section but the object dictionaries by default', () => {
    const s = htmlSections(undefined)
    expect(s.has('bootWrites')).toBe(true)
    expect(s.has('objects')).toBe(false)
  })
  it('follows the stored choice', () => {
    const s = htmlSections({ sections: { objects: true, bootWrites: false } })
    expect(s.has('objects')).toBe(true)
    expect(s.has('bootWrites')).toBe(false)
  })
})

describe('plcVariableUses', () => {
  it('maps aliases and addresses to the variables that name them', () => {
    const uses = plcVariableUses([
      {
        pou: 'main',
        variables: [
          { name: 'level', location: 'tank_level' },
          { name: 'x', location: '' },
        ],
      },
      { pou: 'alarms', variables: [{ name: 'level_in', location: '%IW0' }] },
    ])
    expect(uses.get('tank_level')).toEqual([{ pou: 'main', variable: 'level' }])
    expect(uses.get('%IW0')).toEqual([{ pou: 'alarms', variable: 'level_in' }])
    expect(uses.has('')).toBe(false)
  })
})

describe('buildHtmlDocument', () => {
  it('is one document without scripts or external references', () => {
    const html = buildHtmlDocument(input())
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).not.toMatch(/<script|<link|src=|https?:\/\//i)
    expect(html).toContain('@page{size:A4 landscape')
    const doc = new DOMParser().parseFromString(html, 'text/html')
    expect(doc.querySelectorAll('section.node')).toHaveLength(2)
    expect([...doc.querySelectorAll('nav a')].map((a) => a.textContent)).toContain('2 io2')
  })

  it('shows names as text', () => {
    const config = network()
    config.nodes[1] = { ...config.nodes[1], eds: { ...config.nodes[1].eds, productName: '<b>IO</b>' } }
    const doc = new DOMParser().parseFromString(buildHtmlDocument(input({ config })), 'text/html')
    expect(doc.body.textContent).toContain('<b>IO</b>')
    expect(doc.querySelector('td b')).toBeNull()
  })

  it('names the PLC variables of an address through its alias and directly', () => {
    const config = network()
    const entry = config.nodes[1].tpdos[0].entries[0]
    const uses = plcVariableUses([
      { pou: 'main', variables: [{ name: 'level', location: 'tank_level' }] },
      { pou: 'alarms', variables: [{ name: 'level_in', location: entry.iecLocation }] },
    ])
    const doc = new DOMParser().parseFromString(buildHtmlDocument(input({ config, uses })), 'text/html')
    const row = [...doc.querySelectorAll('#io ~ table tr')].find((tr) => tr.textContent?.includes('tank_level'))
    expect(row?.textContent).toContain('main.level')
    expect(row?.textContent).toContain('alarms.level_in')
    expect(doc.body.textContent).toContain('not used')
  })

  it('leaves out sections that are off', () => {
    const html = buildHtmlDocument(
      input({ sections: htmlSections({ sections: { bootWrites: false, canIds: false, plcVariables: false } }) }),
    )
    expect(html).not.toContain('What the master writes at boot')
    expect(html).not.toContain('id="can-ids"')
    expect(html).not.toContain('PLC variables')
    expect(html).not.toContain('Object dictionary')
  })

  it('decodes boot write values', () => {
    const html = buildHtmlDocument(input())
    expect(html).toMatch(/0x60000108<\/code> <span class="dim">0x6000:01 [^<]*, 8 bits/)
    expect(html).toMatch(/COB-ID 0x182/)
  })

  it('names each PDO picture segment by its alias, else by its object', () => {
    const config = network()
    const [, n2] = config.nodes
    n2.rpdos[0].entries[0] = { ...n2.rpdos[0].entries[0], alias: '' }
    const doc = new DOMParser().parseFromString(buildHtmlDocument(input({ config })), 'text/html')
    const labels = [...doc.querySelectorAll('#node-2 .bar .seg span')].map((s) => s.textContent)
    expect(labels).toContain('tank_level')
    expect(labels).toContain('Digital outputs / Outputs 1-8')
    expect(labels.every((l) => l)).toBe(true)
  })

  it('shows the object dictionary when included', () => {
    const html = buildHtmlDocument(input({ sections: htmlSections({ sections: { objects: true } }) }))
    expect(html).toContain('<details class="od"><summary>Object dictionary')
  })

  it('documents one node', () => {
    const doc = new DOMParser().parseFromString(buildHtmlDocument(input({ nodeId: 'node-3' })), 'text/html')
    expect(doc.querySelectorAll('section.node')).toHaveLength(1)
    expect(doc.querySelector('#node-3')).not.toBeNull()
    expect(doc.body.textContent).not.toContain('2 io2')
  })
})

describe('canIdRows', () => {
  it('lists the frames by COB-ID', () => {
    const config = network()
    const rows = canIdRows(config.network, config.nodes)
    expect(rows[0]).toMatchObject({ cobId: 0, frame: 'NMT' })
    expect(rows.map((r) => r.cobId)).toEqual([...rows.map((r) => r.cobId)].sort((a, b) => a - b))
    expect(rows.some((r) => r.cobId === 0x602 && r.frame === 'SDO request')).toBe(true)
    expect(rows.some((r) => r.duplicate)).toBe(false)
  })
  it('marks a COB-ID two senders use', () => {
    const config = network()
    const [n3, n2] = config.nodes
    n2.rpdos[0] = { ...n2.rpdos[0], cobId: n3.tpdos[0].cobId }
    const rows = canIdRows(config.network, config.nodes).filter((r) => r.cobId === n3.tpdos[0].cobId)
    expect(rows.every((r) => r.duplicate)).toBe(true)
  })
  it('does not mark a TPDO another node receives', () => {
    const config = network()
    const [n3, n2] = config.nodes
    n2.rpdos[0] = { ...n2.rpdos[0], cobId: n3.tpdos[0].cobId, exchanged: false }
    expect(canIdRows(config.network, config.nodes).some((r) => r.duplicate)).toBe(false)
  })
})

describe('buildHtmlExport', () => {
  it('names the file after the network or the node', () => {
    expect(buildHtmlExport(input()).fileName).toBe('canopen1.html')
    const node = buildHtmlExport(input({ nodeId: 'node-2' }))
    expect(node.fileName).toBe('node_2.html')
    expect(node.summary).toMatch(/^1 node, \d+ I\/O, \d+ KB$/)
    expect(node.errors).toEqual([])
  })
})

describe('HTML export format', () => {
  it('needs no device file and saves one file for the network', () => {
    expect(exportNeedsDeviceFile('html')).toBe(false)
    expect(exportFileType('html')).toEqual({
      mime: 'text/html;charset=utf-8',
      name: 'HTML document',
      extensions: ['html'],
    })
    expect(exportStandard('html')).toBeNull()
    const config = network()
    const exported = buildNetworkExport('html', config, {
      now: new Date('2026-11-02T09:30:00Z'),
      networkName: 'canopen1',
      document: { projectName: 'line', editorVersion: '1.0.0', uses: new Map() },
    })
    expect(exported.missing).toEqual([])
    expect(exported.files.map((f) => f.fileName)).toEqual(['canopen1.html'])
    expect(exported.files[0].text).toContain('Project line')
    const node = buildNodeExport('html', config.nodes[0], '', config, { now: new Date(), networkName: 'canopen1' })
    expect(node.fileName).toBe('node_3.html')
  })

  it('lists the sections left out first', () => {
    const config = withHtmlExportOptions(network(), { sections: { bootWrites: false } })
    const losses = exportLosses('html', config.nodes, true, config)
    expect(losses[0]).toBe('the writes the master makes at boot (left out above)')
    expect(losses[1]).toBe('the object dictionaries (left out above)')
    expect(losses).toContain('the device files themselves: only their names and SHA-256')
    expect(htmlLosses(undefined)[0]).toBe('the object dictionaries (left out above)')
  })
})
