/**
 * Writes the corpus of the CI DBC cross-check (.github/workflows/canopen-dbc-crosscheck.yml): DBC
 * files exported from a network of generic I/O modules, the EDS the nodes come from, and the frames
 * with the values the editor expects them to decode to.
 * Runs only when CANOPEN_DBC_CROSSCHECK_OUT names the output folder.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { CanopenConfig, CanopenNode, CanopenObjectInfo } from '../../../ports/canopen-types'
import { buildDbc, defaultDbcExportOptions, withDbcExportOptions } from '../dbc-export'
import { configWith, GENERIC_IO_EDS, genericNode } from './fixtures/helpers'

const OUT = process.env.CANOPEN_DBC_CROSSCHECK_OUT

interface ExpectedFrame {
  file: string
  id: number
  data: string
  /** Signal values after scaling, or the value table text. */
  signals: Record<string, number | string>
}

interface Corpus {
  files: Record<string, { messages: number; sdoNodes: Array<{ nodeId: number; name: string; typed: boolean }> }>
  frames: ExpectedFrame[]
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

function network(): CanopenConfig {
  const io2 = withInfo(genericNode(2), 0x6000, 1, {
    bits: [
      { value: '0', label: 'Start button' },
      { value: '1', label: 'Door closed' },
    ],
  })
  const ai3 = withInfo({ ...genericNode(3), name: 'ai3' }, 0x6401, 1, {
    unit: 'degC',
    multiplier: 0.1,
    label: 'Temperature',
  })
  const long = { ...genericNode(4), name: 'Generic_I_O_module_with_a_long_name' }
  const config = configWith(io2, ai3, long)
  return {
    ...config,
    network: {
      ...config.network,
      syncMode: 'period',
      syncPeriodUs: 10000,
      time: { ...config.network.time, enabled: true },
    },
  }
}

/** `first` followed by zero bytes up to the message's DLC. */
function frameData(text: string, id: number, first: string): string {
  const dlc = Number(new RegExp(`^BO_ ${id} \\w+: (\\d+) `, 'm').exec(text)?.[1])
  return [first, ...new Array<string>(Math.max(dlc - 1, 0)).fill('00')].join(' ')
}

const describeIf = OUT ? describe : describe.skip

describeIf('DBC cross-check corpus', () => {
  it('writes the DBC files and the frames to decode', () => {
    const out = OUT ?? ''
    mkdirSync(out, { recursive: true })
    writeFileSync(join(out, 'generic-io-module.eds'), GENERIC_IO_EDS)
    const config = network()
    const configured = withDbcExportOptions(config, { ...defaultDbcExportOptions(), sdoValues: 'configured' })
    const reduced = withDbcExportOptions(config, { ...defaultDbcExportOptions(), heartbeat: false, sdo: false })
    const files: Array<[string, ReturnType<typeof buildDbc>, boolean]> = [
      ['network.dbc', buildDbc(config, { networkName: 'canopen1' }), true],
      ['configured.dbc', buildDbc(configured, { networkName: 'canopen1' }), false],
      ['node-2.dbc', buildDbc(config, { networkName: 'canopen1', nodes: [config.nodes[0]] }), true],
      ['reduced.dbc', buildDbc(reduced, { networkName: 'canopen1' }), false],
    ]
    const corpus: Corpus = { files: {}, frames: [] }
    for (const [name, dbc, typed] of files) {
      expect(dbc.problems).toEqual([])
      writeFileSync(join(out, name), dbc.text)
      const messages = (dbc.text.match(/^BO_ /gm) ?? []).length
      const sdo = name !== 'reduced.dbc'
      const nodes = name === 'node-2.dbc' ? [config.nodes[0]] : config.nodes
      corpus.files[name] = {
        messages,
        sdoNodes: sdo ? nodes.map((n) => ({ nodeId: n.nodeId, name: n.name, typed })) : [],
      }
    }
    const temperature = config.nodes[1].tpdos.find((p) => p.entries.some((e) => e.index === 0x6401))
    const buttons = config.nodes[0].tpdos.find((p) => p.entries.some((e) => e.index === 0x6000))
    if (!temperature || !buttons) throw new Error('fixture PDOs missing')
    const text = files[0][1].text
    const start = Number(/ SG_ ai3_Temperature : (\d+)\|/.exec(text)?.[1])
    const dlc = Number(new RegExp(`^BO_ ${temperature.cobId} \\w+: (\\d+) `, 'm').exec(text)?.[1])
    const tempBytes = new Array<string>(dlc).fill('00')
    tempBytes[start / 8] = 'EB'
    corpus.frames.push(
      { file: 'network.dbc', id: 0x000, data: '01 02', signals: { NMT_Command: 'Start', NMT_NodeId: 2 } },
      { file: 'network.dbc', id: 0x702, data: '05', signals: { io2_NmtState: 'Operational', io2_Toggle: 0 } },
      { file: 'network.dbc', id: 0x703, data: '7F', signals: { ai3_NmtState: 'Pre-operational' } },
      {
        file: 'network.dbc',
        id: 0x82,
        data: '30 81 11 00 00 00 00 00',
        signals: {
          io2_EmcyCode: 'Life guard or heartbeat error',
          io2_ER_Generic_error: 1,
          io2_ER_Communication_error: 1,
        },
      },
      { file: 'network.dbc', id: 0x80, data: '', signals: {} },
      { file: 'network.dbc', id: temperature.cobId, data: tempBytes.join(' '), signals: { ai3_Temperature: 23.5 } },
      {
        file: 'network.dbc',
        id: buttons.cobId,
        data: frameData(text, buttons.cobId, '02'),
        signals: { io2_Inputs_1_8_Start_button: 0, io2_Inputs_1_8_Door_closed: 1 },
      },
      { file: 'reduced.dbc', id: 0x000, data: '80 00', signals: { NMT_Command: 'Enter pre-operational' } },
    )
    writeFileSync(join(out, 'expected.json'), JSON.stringify(corpus, null, 2))
  })
})
