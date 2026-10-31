/**
 * Screenshots of the CANopen Online tab for a layout review: the basic and expert views, node
 * memory, any-object access and NMT to all nodes, at a wide and a narrow window. Writes PNGs to
 * SCREENSHOT_DIR (default test-results/canopen-online-screens).
 *
 * Needs a production build plus the preload copy; see "Electron e2e" in CLAUDE.md. Port 8443 must be free.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { expect, type Page, test } from '@playwright/test'

import { FakeNode, openDevice } from './helpers/canopen-runtime'
import { quitApp } from './helpers/ethercat-project'

const OUT = process.env.SCREENSHOT_DIR ?? join(__dirname, '..', 'test-results', 'canopen-online-screens')
const FEATURES = ['status', 'sdo', 'nmt', 'service']

type EdsObject = {
  index: number
  subIndex: number
  name: string
  dataType: string
  access: string
  pdoMapping: boolean
}

const nvm = (index: number, subIndex: number, name: string): EdsObject => ({
  index,
  subIndex,
  name,
  dataType: subIndex === 0 ? 'UNSIGNED8' : 'UNSIGNED32',
  access: subIndex === 0 ? 'ro' : 'rw',
  pdoMapping: false,
})

/** Adds 0x1010 and 0x1011 to the node's EDS so that the node memory card shows. */
function addNodeMemory(file: string): void {
  const bus = JSON.parse(readFileSync(file, 'utf8')) as {
    canopenConfig: { nodes: Array<{ eds: { objects: EdsObject[] } }> }
  }
  const objects = bus.canopenConfig.nodes[0].eds.objects
  const extra = [0x1010, 0x1011].flatMap((index) => {
    const verb = index === 0x1010 ? 'Save' : 'Restore default'
    return [
      nvm(index, 0, 'Highest sub-index supported'),
      nvm(index, 1, `${verb} all parameters`),
      nvm(index, 2, `${verb} communication parameters`),
      nvm(index, 3, `${verb} application parameters`),
    ]
  })
  bus.canopenConfig.nodes[0].eds.objects = [...objects, ...extra].sort(
    (a, b) => a.index - b.index || a.subIndex - b.subIndex,
  )
  writeFileSync(file, JSON.stringify(bus, null, 2))
}

function screenNode(): FakeNode {
  const node = new FakeNode()
  const hex = (s: string) => Buffer.from(s, 'latin1').toString('hex')
  for (const [k, v] of [
    ['4096:0', '91010000'],
    ['4097:0', '00'],
    ['4104:0', hex('Generic I/O module with a long manufacturer device name, rev C')],
    ['4116:0', '82000000'],
    ['4118:0', '01'],
    ['4118:1', '00000000'],
    ['4112:0', '03'],
    ['4112:1', '01000000'],
    ['4112:2', '00000000'],
    ['4112:3', '02000000'],
    ['4113:0', '03'],
    ['4120:1', '01000000'],
    ['4120:2', '02000000'],
    ['4120:3', '03000000'],
    ['4120:4', '15cd5b07'],
    ['8448:0', '00000000'],
    ['5120:1', '02020000'],
    ['5120:2', 'ff'],
    ['6144:1', '82010000'],
    ['6144:2', 'ff'],
    ['6656:0', '02'],
    ['6656:1', '08010060'],
    ['6656:2', '10010164'],
    ['5632:0', '01'],
    ['5632:1', '08010062'],
    ['24576:1', '05'],
  ] as const)
    node.values.set(k, v)
  return node
}

const open = (name: string, node: FakeNode) =>
  openDevice(FEATURES, name, node, (project) => addNodeMemory(join(project, 'devices', 'remote', 'canopen_1.json')))

const shot = (page: Page, file: string) => page.screenshot({ path: join(OUT, file) })

test('screenshots of the CANopen Online tabs', async () => {
  test.setTimeout(300000)
  mkdirSync(OUT, { recursive: true })
  const node = screenNode()
  const { app, page, runtime } = await open('openplc-e2e-canopen-screens', node)
  try {
    await page.getByRole('tab', { name: 'Online' }).last().click()
    await page.getByRole('button', { name: 'Read all' }).click()
    await expect(page.getByTestId('canopen-online-value-4119:0')).toHaveText('500', { timeout: 15000 })
    await expect(page.getByRole('button', { name: 'Read all' })).toBeVisible({ timeout: 15000 })
    await shot(page, '01-node-online-basic.png')

    await page.getByRole('button', { name: /Any object/ }).click()
    await page.getByTestId('canopen-online-raw').getByLabel('Index (hex)').fill('1018')
    await page.getByTestId('canopen-online-raw').getByLabel('Sub-index').fill('4')
    await page.getByTestId('canopen-online-raw').getByRole('button', { name: 'Read', exact: true }).click()
    await page.waitForTimeout(500)
    await shot(page, '02-node-online-any-object.png')

    await page.getByRole('switch', { name: 'Expert view' }).first().check()
    await page.waitForTimeout(500)
    await shot(page, '03-node-online-expert.png')

    const row = page.getByTestId('canopen-online-row-8448:0')
    await row.getByLabel('New value for 0x2100:00').fill('25')
    await row.getByRole('button', { name: 'Write' }).click()
    await expect(page.getByTestId('canopen-online-note-8448:0')).toContainText('Write refused', { timeout: 15000 })
    await page.getByTestId('canopen-online-note-8448:0').scrollIntoViewIfNeeded()
    await shot(page, '04-node-online-refused-write.png')

    const memory = page.getByTestId('canopen-online-nvm')
    await memory.scrollIntoViewIfNeeded()
    await memory.getByRole('button', { name: 'Restore defaults' }).click()
    await shot(page, '05-node-memory-confirm.png')
    await memory.getByRole('button', { name: 'Restore defaults' }).last().click()
    await expect(page.getByTestId('canopen-online-nvm-offer')).toBeVisible({ timeout: 15000 })
    await shot(page, '06-node-memory-reset-offer.png')

    const state = page.getByTestId('canopen-online-nmt')
    await state.scrollIntoViewIfNeeded()
    await state.getByRole('checkbox', { name: 'Send to all nodes of the network' }).check()
    await state.getByRole('button', { name: 'Stop' }).click()
    await shot(page, '07-node-state-all-nodes-confirm.png')
    await state.getByRole('alertdialog').getByRole('button', { name: 'Stop' }).click()
    await expect(state).toContainText('Stop sent to every node.', { timeout: 15000 })
    await shot(page, '08-node-state-all-nodes-sent.png')

    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.setSize(1100, 800)))
    await page.waitForTimeout(500)
    await shot(page, '09-node-online-narrow.png')
  } finally {
    await quitApp(app, page)
    runtime.close()
  }
})
